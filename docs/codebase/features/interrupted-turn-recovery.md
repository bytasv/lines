# Interrupted turn recovery

## Purpose

A turn that died with the app (bridge and worker both gone) is detected on reconnect, shown as a yellow Continue banner, and resumed on click — or automatically, if `autoContinueInterrupted` is on. Sessions the worker is still running are healed in the other direction instead, so a bridge restart never mistakes a live turn for a dead one.

The same machinery also covers a worker that never comes back at all — an outage nothing recovers from on its own (crashed process, killed process, a stuck rebuild). Past a deadline the bridge stops waiting for a `hello` that may never arrive and reconciles as if the worker had reported an empty live list, and a global banner tells the user their agent process is gone rather than leaving a silent spinner.

## Entry points

- `server/src/workerClient.ts` (`onHello` -> `withQueuedPushes`; `checkWorkerLost`, `WorkerClient.status`)
- `server/src/sessions.ts` (`SessionManager.reconcileWithWorker`, `continueTurn`, `markTurnLive`)
- `server/src/userRegistry.ts` (`UserRegistry.onWorkerLost`)
- `web/src/components/SessionView.tsx` (Continue banner, sends `continueTurn`)
- `web/src/components/WorkerBanner.tsx` (global "worker not responding" / protocol-mismatch strip)
- `web/src/components/SettingsModal.tsx` (Sessions pane, "Recovery" subgroup)
- `web/src/components/Sidebar.tsx` (session row indicator)

## Files

- `server/src/workerProtocol.ts` (`LiveSessionInfo.busy`)
- `server/src/worker.ts` (`SessionState.busy`, `hello` live list)
- `server/src/workerClient.ts` (`WORKER_LOST_MS`, `onWorkerLost`, `onStatusChange`, `WorkerClient.status`)
- `server/src/userRegistry.ts` (`onWorkerLive` -> per-user `sliceFor`; `onWorkerLost`)
- `server/src/index.ts` (blind-clear timer, `continueTurn` handler, wiring `onStatusChange` to every context's broadcast)
- `server/src/userContext.ts` (field-merge of sync-pulled settings)
- `server/src/sessions.ts`
- `server/src/autoGuard.ts` (`isSelfWorkerSource` — always-ask on edits to the worker's own source)
- `shared/types.ts` (`SessionMeta.interruptedAt`, `UserUiSettings.autoContinueInterrupted`, `WorkerStatus`)
- `web/src/store.ts` (`autoContinueInterrupted`, `pushSettings`/`applySettings`, `workerStatus`)
- `web/src/components/SessionView.tsx`, `web/src/components/SettingsModal.tsx`
- `web/src/components/Sidebar.tsx`, `web/src/lib/format.ts` (`sessionRowMeta`)
- `web/src/components/WorkerBanner.tsx`, `web/src/components/StorageBanner.tsx` (pill precedence)

## Symbols

- `LiveSessionInfo.busy` (`true` = turn in flight, `false` = query open but settled, `undefined` = worker too old to say)
- `SessionManager.reconcileWithWorker` — takes `{ autoContinue?: boolean }`; the worker-lost path passes `autoContinue: false` so sessions are flagged for the banner without also firing a resume that would just re-queue into `WorkerClient.pending`
- `SessionManager.markTurnLive` (promote a stale-idle session back to running)
- `SessionManager.continueTurn`
- `hasUnresolvedAlwaysAsk` (`server/src/sessions.ts`) — gates both auto-continue's `flagged` list and `expireUnresolvedPermissions`
- `SessionMeta.interruptedAt` (the banner flag)
- `sessionRowMeta` (`web/src/lib/format.ts`) — sidebar row equivalent of the banner
- `withQueuedPushes` (bridge-side: a queued `push` counts as live)
- `UserUiSettings.autoContinueInterrupted`
- `WORKER_LOST_MS` (`server/src/workerClient.ts`) — how long the socket may be down before the outage is treated as real
- `WorkerClient.status` / `onStatusChange` — derived `WorkerStatus` (`connected`, `since`, `mismatch`), published only on a transition
- `UserRegistry.onWorkerLost` — reconciles every context's sessions with an empty live list, `autoContinue: false`
- `WorkerStatus` (`shared/types.ts`) — the `hello.worker` / `workerStatus` broadcast payload
- `WorkerBanner` (`web/src/components/WorkerBanner.tsx`) — the global pill rendering `WorkerStatus`
- `isSelfWorkerSource` (`server/src/autoGuard.ts`) — true for `worker.ts`/`workerProtocol.ts`/`workerMcp.ts` under this bridge's own `server/src`

## Data flow

The worker tracks `busy` per session (`true` on `push`, `false` on the turn's `result`) and reports it in `hello.live`. `WorkerClient` folds in the sessions whose `push` is still queued locally — the snapshot predates that flush — and hands the merged list to `reconcileWithWorker`, per user via `UserRegistry.sliceFor`.

Reconcile then moves in both directions. `busy: true` on a session we believe is idle calls `markTurnLive` (status back to `running`, keep a known `turnStartedAt`, clear `interruptedAt`). Absent from the list, or `busy: false`, on a session we believe is `running`/`waiting-permission` demotes it to `idle`, pauses any queue, and stamps `interruptedAt`. `busy: undefined` demotes only.

`continueTurn` expires the dead turn's orphaned permission cards, releases `queuePaused`, and re-prompts with a synthetic nudge, resuming through `claudeSessionId`. A turn interrupted mid-workflow-step resumes with source `'workflow'` so its result still parks the step for approve/retry. A card for an `ALWAYS_ASK_TOOLS` request (`ExitPlanMode`, `AskUserQuestion`) is skipped by this expiry — see [permission-resolution-provenance](permission-resolution-provenance.md).

Unless `autoContinueInterrupted` is `false`, reconcile then calls `continueTurn` for the sessions **that pass flagged**, after the `maybeFlush` sweep, each inside its own try/catch. A session demoted with an unresolved `ALWAYS_ASK_TOOLS` card is stamped `interruptedAt` (banner still shows) but never added to `flagged`, so auto-continue cannot resume it — its nudge text ("continue the task from there") would otherwise read as an approval the user never gave.

## Tests

`server/src/sessions.reconcile.test.ts` — promote/demote/old-worker matrix, event-based healing, stop-ordering, `withQueuedPushes`, the auto-continue cases (fresh flag resumes, absent setting resumes, explicit `false` does not, stale flag does not, workflow source preserved, a meta with no `caveman` resumes, one failing session doesn't stop the others, `result`/archive clear the flag, an unresolved `ExitPlanMode` card blocks auto-continue and is not expired by `continueTurn`, an ordinary tool's card still expires), and the worker-lost case (reconciled with an empty live list, `autoContinue: false`, never auto-resumed).

`server/src/workerClient.test.ts` — `onWorkerLost` fires once at the deadline and not on a reconnect inside it; `onStatusChange` publishes a disconnected status once per outage, a connected status once on recovery, nothing on an in-deadline reconnect, and a `mismatch` status for a worker that only ever answers on the wrong protocol version (without `everConnected` ever becoming true).

`server/src/autoGuard.worker.test.ts` — `isSelfWorkerSource`/`assessToolCall` treat edits to this bridge's own `worker.ts`/`workerProtocol.ts`/`workerMcp.ts` as always-ask, leave a same-named file elsewhere untouched, leave reads untouched, and confirm a blanket `{ tool: 'Edit' }` allowlist entry cannot disarm the rule.

The settings field-merge in `userContext.ts` is uncovered — `buildUserContext` wires sync, stores and a worker together with no seam. Verified by hand.

## Business rules

- Auto-continue only fires for sessions flagged by the reconcile that is running. A flag left from an earlier crash keeps its banner, so a restart can't fan out into a pile of unattended turns.
- Auto-continue never fires while a session holds an unresolved `ExitPlanMode`/`AskUserQuestion` card (`hasUnresolvedAlwaysAsk`) — that decision is the user's alone. The session still gets the banner and its sidebar dot; the card stays open and clickable, and a later click recovers it via `recoverOrphanedPermission` rather than the server nudging the turn forward on its own.
- `continueTurn`'s card expiry skips those same `ALWAYS_ASK_TOOLS` requests for the same reason — see [permission-resolution-provenance](permission-resolution-provenance.md).
- Auto-continue is on unless `autoContinueInterrupted` is explicitly `false`. Absent — including no `settings.json` at all — means enabled, so a fresh install recovers without configuration.
- A resume that throws is contained per session: the failure is logged, the session is put back into the flagged state so its banner returns, and the sessions after it still resume.
- Settings pulled from the storage server are merged field-wise, not replaced wholesale, so a client that predates a setting cannot erase it by omitting it from its payload.
- `interruptedAt` is cleared by a new prompt, by a `result` (the turn had in fact finished), by `markTurnLive`, and by archive/complete. It is deliberately **not** cleared by `ackSession` — viewing a session must not hide the banner before it can be read.
- The sidebar row shows the same yellow "interrupted" dot/badge as the banner, via `sessionRowMeta`, which reuses the banner's exact guard (`interruptedAt && !isSessionActive(status) && status !== 'error'`). It persists across switching to the session and back, for the same `ackSession` reason as the banner.
- The blind-clear timer in `index.ts` fires only when no worker ever answered *and* it never saw an incompatible protocol version; a worker that answered on an incompatible version is alive and possibly mid-turn, so its statuses are left alone (`WorkerClient.sawIncompatibleWorker`). A cold-start protocol mismatch is instead surfaced immediately through `WorkerStatus.mismatch` (see below) rather than waiting on this timer or the lost deadline.
- The socket may be down for `WORKER_LOST_MS` (20s) before the bridge treats it as a real outage rather than an ordinary tsx-watch restart, which reconnects in roughly 1-2s (retry loop plus the runtime-file watch). Only an outage past that deadline reconciles and shows the banner.
- The worker-lost path flags every in-flight session (banner, paused queue, `interruptedAt`) but never auto-continues them, even when `autoContinueInterrupted` is on — resuming would just re-queue the push into `WorkerClient.pending` against a worker that isn't there. The next real `hello` reconciles normally and, if flagged, resumes them then.
- A cold-start protocol mismatch (a worker that has never once answered compatibly) cannot be caught by the lost deadline: `everConnected` never becomes `true`, so the outage clock never starts. It is instead surfaced the moment the mismatched `hello` is seen, via `WorkerStatus.mismatch`, independent of `WORKER_LOST_MS`.
- Exactly one of `ConnectionBanner`, `WorkerBanner`, `StorageBanner` renders at a time — all three share the same fixed position. `ConnectionBanner` (browser<->bridge down) outranks both; `WorkerBanner` (agent worker down) outranks `StorageBanner` (cloud sync paused), since a dead agent is worse than paused sync.

## Architectural rules

- Adding a field to `LiveSessionInfo` is not a protocol bump; adding a message type is. `busy` was added as an optional field on purpose, so an old worker keeps working (demote-only) instead of having its socket closed with turns in flight.
- Reconcile must stay the only place that stamps `interruptedAt`. The banner means "your turn died", not "something looked odd".
- A `result` arriving for a session with `interruptedAt` set means the flag was wrong — a result buffered while the bridge was away lands after reconcile. Clear it there rather than adding ordering machinery to the handshake.
- `onStatusChange` (bridge health, for the UI) is kept separate from `onWorkerLost` (the session-reconcile trigger) rather than merged into one callback — one publishes health, the other drives a state transition, and coupling them would tie the banner to reconcile timing.
- `isSelfWorkerSource`'s check runs before the guard's blanket `{ tool: 'Edit' }`/`{ tool: 'Write' }` allowlist short-circuit, not after — a standing allowlist entry must not silently disarm the one write that kills the turn making it.
- `isSelfWorkerSource` is self-locating (resolves `worker.ts`/`workerProtocol.ts`/`workerMcp.ts` under this bridge's own `import.meta.dirname`) rather than threading session/bridge identity into `assessToolCall`, which otherwise knows only `roots: string[]`. A packaged build that doesn't run from `server/src` matches nothing, so the rule silently no-ops there (fails safe) rather than protecting a shipped app.

## Related decisions

- [session-status-badge](session-status-badge.md) — how these statuses render.
- [workflow-stop-parks](workflow-stop-parks.md) — the other path that settles a turn without a normal result; a plain Stop parks rather than advances.
- [permission-resolution-provenance](permission-resolution-provenance.md) — why auto-continue and expiry both defer to an open `ALWAYS_ASK_TOOLS` card.
