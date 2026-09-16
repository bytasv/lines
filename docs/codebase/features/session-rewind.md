# Session rewind

Covers: `session-rewind`.

## Purpose

Recover a session whose context overflowed mid-conversation. Retry alone cannot help there — it
re-sends into the same CLI conversation, whose on-disk history still contains the oversized
prompt, so it overflows again. Manual compaction needs a turn that can run, which is the thing
that is broken. The only prior escape was a full `resetClaudeSession` wipe, discarding every
prior turn.

Rewind instead truncates the session **in place** (same session id) from a chosen `'user'`
transcript message on, re-points the CLI conversation at the truncated history via the SDK's
`forkSession`, and either discards that message with the rest (**Delete**) or hands its text
back to the composer to edit and resend (**Edit**). Nothing is ever auto-resubmitted. Works the
same way whether or not the session's workflow has started — changing your mind mid-workflow
rolls the workflow's own step bookkeeping back to whatever step the surviving transcript still
shows, and parks there for review.

## Entry points

- Transcript: hover a sent prompt bubble → Copy / Edit / Delete-from-here icon row below it.
- `web/src/components/Composer.tsx` — prefills from an Edit's returned prompt.

## Files

- `shared/types.ts` — `ClientMessage` (`rewindSession { sessionId, seq, edit? }`), `ServerMessage`
  (`rewound`, `transcriptTruncated`), `MESSAGE_AUTHZ.rewindSession`, `RewindPrompt`,
  `RewindBlockCode`, `RewindBlockInfo`, `rewindBlock(meta)`
- `server/src/sessions.ts` — `SessionManager.rewindSession`, `RewindListener`,
  `SessionManager.setRewindListener`/`onRewind`, `SessionManager.reloadAttachments` (shared with
  `lastPromptForRetry`), `SessionManager.rewinding`
- `server/src/store.ts` — `Store.truncateTranscript`, transcript cache invalidation, the
  `transcripts/<sessionId>.rewind-<ts>.jsonl` sidecar, `deleteTranscript`'s sidecar cleanup
- `server/src/workflows.ts` — `WorkflowEngine.rollbackToTranscript` (registered as the rewind
  listener in the constructor)
- `server/src/index.ts` — `case 'rewindSession'`
- `web/src/store.ts` — `composerPrefill`, `takeComposerPrefill`, `case 'rewound'`,
  `case 'transcriptTruncated'`
- `web/src/components/Transcript.tsx` — `UserBubble`, `RewindIntent`
- `server/src/workerCodex.ts` — `forkCodex(sessionId, lastTurnId, threadId?)` — the
  explicit `threadId` is the cross-era rewind path (see Crossing a provider switch)
- `web/src/components/Composer.tsx` — the prefill effect

## Symbols

- `rewindBlock(meta)` — single predicate (server guard + the icon row's `disabled` + its tooltip)
  deciding whether a rewind can run right now; mirrors `contextCompactBlock`'s shape. Blocks only
  on a live turn (`running`/`waiting-permission`) or no `claudeSessionId` yet — a started
  workflow is deliberately **not** a blocker (see Business rules).
- `SessionManager.rewindSession(sessionId, seq, { edit? })` — the whole operation: gate, resolve
  the CLI anchor, fork, truncate, notify, settle.
- `RewindListener` / `SessionManager.onRewind` — one hook a listener can register to roll its own
  transcript-derived state back after truncation, and optionally settle the session itself
  (skipping the default `idle`). Registered once, by `WorkflowEngine`, mirroring
  `TurnCompleteListener`.
- `WorkflowEngine.rollbackToTranscript(sessionId)` — the workflow's rewind listener.
- `Store.truncateTranscript(sessionId, fromSeq)` — drops events at/after `fromSeq`, archives them
  to a sidecar first, invalidates the transcript cache.
- `RewindPrompt` — `{ text, mentions?, attachments }`, the shape handed back to the composer on
  an Edit; rehydrated from disk the same way a retry rehydrates its prompt.
- `restoreEra(sessionId, model, pointers)` — puts the session's model and resume pointer
  back together after a rewind resolves them to something other than what is running now
  (see Crossing a provider switch). Model and pointer always move as one; never reused by
  `switchProvider`, which has the opposite direction (dropping a conversation, not
  restoring one).

## Data flow

1. Client sends `{ type: 'rewindSession', sessionId, seq, edit? }`, `seq` naming a `kind: 'user'`
   transcript event.
2. `SessionManager.rewindSession` gates on `rewindBlock` and a `rewinding` in-flight claim (taken
   synchronously, before the first `await`, so a double-click cannot race two rewinds past the
   gate), then confirms `seq` really is a `'user'` event.
3. Resolves the **era** the target belongs to — see Crossing a provider switch. For a
   target that never crosses a `provider-switch` marker this is just `meta`'s own model
   and pointer, exactly as before.
4. Scans backwards from `seq`, bounded below by the era's **floor** (the newest switch
   marker at or before the target, `-1` when none), for the nearest `kind: 'sdk'` event
   with `data.type === 'assistant'` and a `uuid` — the CLI anchor the SDK's
   `forkSession`/`resumeSessionAt` documents `upToMessageId` against. Every
   non-`stream_event` SDK message is already persisted verbatim by `handleWorkerEvent`, so
   the anchor is already on disk; no new capture needed. The floor stops an anchor being
   borrowed from a conversation the fork target has never seen.
5. **Fork before touching Lines' own transcript.** With an anchor and a conversation to
   fork (the era's own pointer, `meta`'s own pointer when the era matches it):
   `forkSession(pointer, { upToMessageId, dir: cwd })` (or `codexFork` with an explicit
   thread id for a codex era), then `restoreEra` sets the model and the fork's new pointer
   together and `closeQuery(sessionId)` — the next ordinary `prompt()` resumes the fork
   through the existing `resume:` line in `buildQueryOptions`, no new query option. With no
   anchor, or an era whose pointer was never recorded: degrades to
   `resetClaudeSession(sessionId)` followed by `restoreEra` on the era's model alone — the
   right model, a fresh conversation. A fork failure aborts here; nothing below has run
   yet.
5. `store.truncateTranscript(sessionId, seq)`, then `liveState(sessionId).seq = seq` so the next
   `emitEvent` resumes the numbering where the discarded tail began.
6. **Broadcasts `transcriptTruncated` itself**, from inside `rewindSession` — not from the
   `index.ts` handler — so it is ordered *before* anything a rewind listener emits next (see
   Architectural rules).
7. `flushPending(sessionId)` rejects the discarded query's pending permission callbacks with no
   resolution event (the events they'd land in were just truncated away).
8. `onRewind?.(sessionId)` — `WorkflowEngine.rollbackToTranscript` when a workflow is attached;
   see below. Returns `true` if it settled the session itself.
9. `contextResetAt`/`contextCompact` reset (same treatment as `resetClaudeSession`, same reason:
   a new CLI conversation is a new compaction verdict). If the listener settled the session,
   `persistMeta` only (don't clobber its park); otherwise `setStatus('idle')`.
10. Reply: `{ type: 'rewound', ... prompt }` unicast to the asking link, **only when `edit` was
    true** — a plain Delete returns no prompt and skips the attachment-rehydration read entirely.

### Workflow rollback (`rollbackToTranscript`)

`WorkflowState` lives on `SessionMeta`, not in the transcript — truncating events alone would
leave `stepIndex` pointing at a step whose `'started'` marker no longer exists, and
`findStepStart` would return `-1`. The listener re-derives step position from the *surviving*
transcript's newest `'started'`/`'retried'` workflow marker:

- Steps before that marker's `stepIndex` → `done`; that step → `waiting-approval`; later steps →
  `pending`. Parked, not re-run — a follow-up prompt then iterates the same step
  (`iterateIfWaiting`) and Approve advances, exactly like an ordinary park.
- Outputs (`WorkflowState.outputs`) published by the rolled-back step and any step after it are
  deleted, so a later `{outputs.<name>}` substitution can't silently hand on work that was
  rewound away.
- `advanceOnComplete`/`advanceOnCompleteStep`/`advancing`/`stepFailure` cleared — they describe
  turns that no longer exist. `lastStepOutput` cleared (not recomputed) so the `{previous}`
  hand-off falls back to `lastAssistantText` over the truncated transcript.
- No surviving marker at all (rewound past the task description, step 0's very first prompt):
  the workflow is put back to `attach()`'s unstarted shape (`started: false`, `task` cleared,
  every `stepStatuses` entry `'pending'`) so the next prompt starts it again. `diffBaselines` is
  kept — the working tree did not roll back with the transcript.
- Per-step spend (`stepCostsUsd`/`stepTokens`/`stepDurationsMs`) is **not** rewound — same rule
  as cumulative session spend (see Business rules): the turns really ran.

### Crossing a provider switch

A [cross-provider switch](cross-provider-model-switching.md) replaces the session's live
conversation and pointer, so a rewind target from before the switch belongs to a
conversation the session's *current* pointer cannot name. Rewind resolves an **era** for
the target rather than assuming `meta`'s own model and pointer are always the right ones:

- Scan every `'provider-switch'` marker in the transcript. The first one **after** the
  target names the era it belongs to: `{ model: marker.from, sessionId: marker.fromSessionId }`.
  The newest one **at or before** the target only sets the **floor** — it does not change
  the era, because a target with no switch after it is still inside the conversation
  running *now*, and the session's own model is authoritative there (reading it off an
  older marker would undo a plain `setModel` made since).
- With an era resolved and its `fromSessionId` present: fork that conversation at an
  anchor bounded by the floor, then `restoreEra` puts the session back on that era's model
  and the new fork.
- With an era resolved but no `fromSessionId` (a switch recorded before that field
  existed): `resetClaudeSession` plus `restoreEra` on the era's model alone — the
  conversation is unrecoverable, but the session still lands on the *right* model rather
  than continuing on the wrong one.
- Crossing eras also clears the context-occupancy readings, the last compaction verdict,
  and (if the era's provider differs from the session's own) the workflow's
  `providerSwitched` one-shot flag — all of them describe a conversation being left.

The confirm dialog names this before the click: which model the rewind falls back to, and
whether that conversation is still forkable or the session will start fresh there — the
same “still on this machine?” uncertainty the switch itself carries.

## Dependencies

- `@anthropic-ai/claude-agent-sdk`'s `forkSession(sessionId, { upToMessageId, dir })` — copies a
  CLI session's transcript up to a message UUID into a new session file with remapped UUIDs.
  Verified against the SDK's type declarations; not yet exercised against a real CLI session on
  disk in production. `resumeSessionAt` (a `query()` option) is the documented fallback if
  `forkSession` proves unusable at runtime, at the cost of the fork-before-truncate ordering
  guarantee below.

## Tests

- `server/src/sessions.rewind.test.ts` — `rewindBlock` per code and the settled-session/started-
  or-not-workflow pass-through cases; gate cases (busy, no `claudeSessionId`, non-`'user'` seq);
  anchor resolution (nearest preceding assistant uuid, uuid-less/non-assistant events skipped,
  first-prompt rewind degrades to `resetClaudeSession`); fork-failure abort before any transcript
  mutation; the in-flight `rewinding` claim blocking a concurrent second call; successful-path
  truncation, seq renumbering, status/error/`contextCompact` reset, spend preservation; Edit vs.
  Delete prompt shape (`RewindPrompt` populated vs. `null`); attachment rehydration with a
  missing file dropped; the rewind sidecar's contents; a rewind listener settling the session
  instead of it being idled; the `transcriptTruncated` broadcast ordered before a listener's
  emitted events; rewinding above a switch restores the abandoned conversation and model at
  a floor-bounded anchor; a rewind fully inside a later era forks that era's own thread,
  naming it explicitly; an anchor is never borrowed from across the switch; a switch marker
  recorded without `fromSessionId` degrades to a fresh conversation on the right model.
- `server/src/workflows.rewind.test.ts` — `rollbackToTranscript`: park lands on the right step;
  rolling into an earlier step demotes later ones to `pending`; output pruning for rolled-back
  steps; full un-start past every step marker; `advanceOnComplete`/`advancing`/`stepFailure`/
  `lastStepOutput` cleared; per-step spend kept; the parked step's `'started'` marker survives in
  the truncated transcript (so `findStepStart` still finds it); the park marker is broadcast
  after the truncation frame; a session with no workflow attached is unaffected.
- `server/src/store.test.ts` — `truncateTranscript`: correct cut index, sidecar contents match
  the dropped lines, cache invalidation (`loadTranscript`'s returned array is not mutated out
  from under a caller still holding it), a past-the-end seq truncates nothing, appends after a
  truncation land on the truncated file, `deleteTranscript` removes that session's sidecars too.
- `server/src/sessions.reconcile.test.ts` — a rewound session reconciles cleanly afterward (no
  `interruptedAt` stamped, no orphaned permission cards from the discarded query) — see
  [turn-recovery](turn-recovery.md).

## Business rules

- Truncate-in-place only: no branching, no tree of alternate histories, no UI to switch between
  them. The discarded tail is recoverable only by hand, from the sidecar file.
- Never auto-resubmits. Edit only prefills the composer; the user must send it themselves — the
  whole point is letting them trim the oversized paste before it goes near the model again.
- A started workflow does **not** block a rewind — changing your mind mid-workflow is a primary
  reason to use it. `rollbackToTranscript` (see Data flow) makes this safe by keeping
  `WorkflowState` in sync with whatever the truncated transcript still shows.
- Cumulative session spend (`totalCostUsd`, `totalTokens`) and per-step spend are deliberately
  **not** rewound — that money was really spent. The visible cost counter can look
  disproportionate to the now-shorter visible transcript; this is intentional, not a bug.
- Edit reloads attachments from disk only when `edit: true` was requested — a plain Delete never
  pays that read, since the attachments are discarded either way.
- The confirm dialog states plainly what is lost: the message itself is deleted either way (only
  Edit keeps its text, in the composer, not the transcript); every reply and prompt after it is
  deleted too; the operation is irreversible and does not refund the discarded turns' cost. When
  no earlier assistant reply exists to fork at, the dialog also says Claude's memory of the
  session is being cleared completely (the `resetClaudeSession` degrade path). When a workflow
  has started, it names the step the session parks back on and that later steps' outputs are
  discarded.
- Copy (of the message's own text) is never gated by `rewindBlock` — reading your own text back
  is not a session-mutating action.
- Rewinding above a provider switch restores the model and, when the switch recorded its
  abandoned pointer (`ProviderSwitchData.fromSessionId`), forks and resumes that
  conversation for real — model and pointer always move together. A switch made before
  that field existed degrades to the right model with a fresh conversation, never the
  wrong model with a stale pointer.

## Architectural rules

- Fork-then-truncate ordering is deliberate: a fork failure must leave Lines' own transcript
  untouched. This is why `forkSession` is awaited eagerly inside `rewindSession` rather than
  deferred to the next `prompt()` via a `resumeSessionAt` + `forkSession: true` one-shot option
  pair — that alternative would have to persist one-shot state on `SessionMeta`, and could only
  fail *after* Lines' transcript was already truncated.
- `rewindSession` broadcasts `transcriptTruncated` itself, not `index.ts`'s WS handler — a
  rewind listener (`WorkflowEngine.rollbackToTranscript`) may emit transcript events of its own
  (a park marker) as part of settling, and those must be ordered *after* the truncation frame on
  the wire. A client applies `transcriptTruncated` by dropping every locally-held event with
  `seq >= msg.seq`; if the park marker arrived first, that filter would delete it along with the
  tail it's meant to replace.
- `RewindListener` mirrors `TurnCompleteListener`'s existing shape (one optional hook
  `SessionManager` calls, registered once by `WorkflowEngine`'s constructor) rather than adding a
  new dependency edge from `SessionManager` to `WorkflowEngine` — `SessionManager` still has no
  reference to workflow internals.
- `store.truncateTranscript` invalidates the transcript cache rather than trimming the cached
  entry in place — `entry.lines`/`entry.parsed` are handed to live readers by reference
  (`loadTranscript`'s "shared, not copied" contract), so mutating them under a caller still
  holding the array would corrupt it.
- The dropped tail is archived to `transcripts/<sessionId>.rewind-<ts>.jsonl` before the live
  file is rewritten (archive-then-truncate), so a crash between the two steps costs a duplicate
  sidecar rather than losing the discarded turns. No read path or cleanup job consumes these
  files — they exist for manual recovery only, and accumulate with repeated rewinds on the same
  session (called out, not solved, for v1).
- `rewinding` (a `Set<string>` claim) is taken synchronously before `rewindSession`'s first
  `await`, mirroring `compacting`'s guard against a second concurrent request on the same
  session.
- `RewindPrompt`'s attachment rehydration reuses `SessionManager.reloadAttachments`, extracted
  out of `lastPromptForRetry` so both paths reload identically rather than duplicating the
  base64-from-disk logic.
- The era's floor bounds both the Claude-uuid and the codex-turn-id anchor scans
  identically — an anchor is never resolved by asking "is this the current session's
  provider" and scanning the whole transcript, because the current provider is not
  necessarily the era's provider.
- `restoreEra` is the only place model and resume pointer are set together outside
  `switchProvider`/`resetClaudeSession`; it exists specifically so a rewind can never
  leave a session on one provider's model holding the other's pointer — the exact state
  `setModel` refuses to create in the first place.

## Related decisions

- [turn-recovery](turn-recovery.md) — rewind is the third recovery path, for the one case Retry
  and manual compaction cannot reach: the oversized prompt causing the overflow is itself still
  in the CLI's history.
- [context-window](context-window.md) — `contextResetAt`/`contextCompact` reset the same way
  `resetClaudeSession` already resets them, and for the same reason.
- [session-collaboration](session-collaboration.md) — a second, structurally different "edit
  before send": `editQueued` rewrites a prompt that has not sent yet; rewind's Edit discards an
  already-sent prompt and refills the composer. Not a generalization of one into the other.
- [workflow-step-lifecycle](workflow-step-lifecycle.md) — `rollbackToTranscript`'s park uses the
  same `waiting-approval` step-lifecycle state and `iterateIfWaiting`/Approve controls as an
  ordinary step park.
- [cross-provider-model-switching](cross-provider-model-switching.md) — the source of the
  `'provider-switch'` markers and `fromSessionId` pointer this doc's era resolution reads.

## On a codex session

`thread/fork` anchors on a **turn**, not a message: it keeps everything up to and including
`lastTurnId`. So rewinding to a prompt means forking at the turn that settled before it, and
the turn ids have to survive — each settling `result` carries `_codexTurnId` on its durable
record, because a rewind can happen many restarts after the turn did.

Forking answers a *new* thread and the session re-points at it, so codex's own history stays
intact on disk even though the Lines transcript is truncated. The gate is provider-neutral: it
asks for a conversation on either provider, not for a `claudeSessionId`. See
[openai-codex-sessions](openai-codex-sessions.md).

`forkCodex`'s `threadId` parameter is optional and normally omitted — the worker forks its own
live binding. It is only supplied for a rewind that crosses back into a codex era the current
worker holds no binding for (see Crossing a provider switch above); the bridge reads the id off
the abandoned `provider-switch` marker and writes the fork's result onto the session so the
next push binds to it exactly as a cold worker would.
