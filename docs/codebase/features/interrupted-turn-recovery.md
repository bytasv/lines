# Interrupted turn recovery

## Purpose

A turn that died with the app (bridge and worker both gone) is detected on reconnect, shown as a yellow Continue banner, and resumed on click — or automatically, if `autoContinueInterrupted` is on. Sessions the worker is still running are healed in the other direction instead, so a bridge restart never mistakes a live turn for a dead one.

## Entry points

- `server/src/workerClient.ts` (`onHello` -> `withQueuedPushes`)
- `server/src/sessions.ts` (`SessionManager.reconcileWithWorker`, `continueTurn`, `markTurnLive`)
- `web/src/components/SessionView.tsx` (Continue banner, sends `continueTurn`)
- `web/src/components/SettingsModal.tsx` ("Recovery" section)
- `web/src/components/Sidebar.tsx` (session row indicator)

## Files

- `server/src/workerProtocol.ts` (`LiveSessionInfo.busy`)
- `server/src/worker.ts` (`SessionState.busy`, `hello` live list)
- `server/src/workerClient.ts`
- `server/src/userRegistry.ts` (`onWorkerLive` -> per-user `sliceFor`)
- `server/src/index.ts` (blind-clear timer, `continueTurn` handler)
- `server/src/userContext.ts` (field-merge of sync-pulled settings)
- `server/src/sessions.ts`
- `shared/types.ts` (`SessionMeta.interruptedAt`, `UserUiSettings.autoContinueInterrupted`)
- `web/src/store.ts` (`autoContinueInterrupted`, `pushSettings`/`applySettings`)
- `web/src/components/SessionView.tsx`, `web/src/components/SettingsModal.tsx`
- `web/src/components/Sidebar.tsx`, `web/src/lib/format.ts` (`sessionRowMeta`)

## Symbols

- `LiveSessionInfo.busy` (`true` = turn in flight, `false` = query open but settled, `undefined` = worker too old to say)
- `SessionManager.reconcileWithWorker`
- `SessionManager.markTurnLive` (promote a stale-idle session back to running)
- `SessionManager.continueTurn`
- `SessionMeta.interruptedAt` (the banner flag)
- `sessionRowMeta` (`web/src/lib/format.ts`) — sidebar row equivalent of the banner
- `withQueuedPushes` (bridge-side: a queued `push` counts as live)
- `UserUiSettings.autoContinueInterrupted`

## Data flow

The worker tracks `busy` per session (`true` on `push`, `false` on the turn's `result`) and reports it in `hello.live`. `WorkerClient` folds in the sessions whose `push` is still queued locally — the snapshot predates that flush — and hands the merged list to `reconcileWithWorker`, per user via `UserRegistry.sliceFor`.

Reconcile then moves in both directions. `busy: true` on a session we believe is idle calls `markTurnLive` (status back to `running`, keep a known `turnStartedAt`, clear `interruptedAt`). Absent from the list, or `busy: false`, on a session we believe is `running`/`waiting-permission` demotes it to `idle`, pauses any queue, and stamps `interruptedAt`. `busy: undefined` demotes only.

`continueTurn` expires the dead turn's orphaned permission cards, releases `queuePaused`, and re-prompts with a synthetic nudge, resuming through `claudeSessionId`. A turn interrupted mid-workflow-step resumes with source `'workflow'` so its result still parks the step for approve/retry.

Unless `autoContinueInterrupted` is `false`, reconcile then calls `continueTurn` for the sessions **that pass flagged**, after the `maybeFlush` sweep, each inside its own try/catch.

## Tests

`server/src/sessions.reconcile.test.ts` — promote/demote/old-worker matrix, event-based healing, stop-ordering, `withQueuedPushes`, and the auto-continue cases (fresh flag resumes, absent setting resumes, explicit `false` does not, stale flag does not, workflow source preserved, a meta with no `caveman` resumes, one failing session doesn't stop the others, `result`/archive clear the flag).

The settings field-merge in `userContext.ts` is uncovered — `buildUserContext` wires sync, stores and a worker together with no seam. Verified by hand.

## Business rules

- Auto-continue only fires for sessions flagged by the reconcile that is running. A flag left from an earlier crash keeps its banner, so a restart can't fan out into a pile of unattended turns.
- Auto-continue is on unless `autoContinueInterrupted` is explicitly `false`. Absent — including no `settings.json` at all — means enabled, so a fresh install recovers without configuration.
- A resume that throws is contained per session: the failure is logged, the session is put back into the flagged state so its banner returns, and the sessions after it still resume.
- Settings pulled from the storage server are merged field-wise, not replaced wholesale, so a client that predates a setting cannot erase it by omitting it from its payload.
- `interruptedAt` is cleared by a new prompt, by a `result` (the turn had in fact finished), by `markTurnLive`, and by archive/complete. It is deliberately **not** cleared by `ackSession` — viewing a session must not hide the banner before it can be read.
- The sidebar row shows the same yellow "interrupted" dot/badge as the banner, via `sessionRowMeta`, which reuses the banner's exact guard (`interruptedAt && !isSessionActive(status) && status !== 'error'`). It persists across switching to the session and back, for the same `ackSession` reason as the banner.
- The blind-clear timer in `index.ts` fires only when no worker ever answered; a worker that answered on an incompatible protocol version is alive and possibly mid-turn, so its statuses are left alone (`WorkerClient.sawIncompatibleWorker`).

## Architectural rules

- Adding a field to `LiveSessionInfo` is not a protocol bump; adding a message type is. `busy` was added as an optional field on purpose, so an old worker keeps working (demote-only) instead of having its socket closed with turns in flight.
- Reconcile must stay the only place that stamps `interruptedAt`. The banner means "your turn died", not "something looked odd".
- A `result` arriving for a session with `interruptedAt` set means the flag was wrong — a result buffered while the bridge was away lands after reconcile. Clear it there rather than adding ordering machinery to the handshake.

## Related decisions

- [session-status-badge](session-status-badge.md) — how these statuses render.
- [workflow-stop-advances](workflow-stop-advances.md) — the other path that settles a turn without a normal result.
