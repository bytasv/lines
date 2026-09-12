# Turn interjection

## Purpose

"Send now" on a queued prompt: deliver it into the turn that is already running instead of
waiting for that turn to settle — the Lines analog of typing "btw ..." into Claude Code mid-turn.

The send path itself is untouched. A prompt typed while the session is busy still lands in the
ordinary queue (`SessionManager.userPrompt`), renders as a row in `QueuedMessages.tsx`, and can
still be edited or cancelled. Each row gains one more action: a lightning icon that lifts that
one item out of the queue and pushes it into the live turn.

The design rests on an empirically established CLI behaviour, not a documented SDK contract —
see [Data flow](#data-flow) for the measurement and its result. `SDKUserMessage.priority?: 'now'
| 'next' | 'later'` appears nowhere in the SDK docs, only in `sdk.d.ts`.

## Entry points

- The lightning `ActionIcon` on a queued-prompt row, before Edit and the cancel X
  (`web/src/components/QueuedMessages.tsx`)
- `{ type: 'interjectQueued', sessionId, queuedId }` client message
  (`server/src/index.ts` `handleMessage`)
- `SessionManager.interjectQueued` (`server/src/sessions.ts`)

## Important files

- `shared/types.ts` — `ClientMessage.interjectQueued`, its `MESSAGE_AUTHZ` row, `InterjectData`,
  `TranscriptEvent.kind` gains `'interject'`
- `server/src/sessions.ts` — `canInterject`, `interjectQueued`, `pushIntoLiveTurn` (the shared
  `intoLiveTurn` push both `interjectQueued` and the plan-comments approval path in
  [permissions-and-plan-mode](permissions-and-plan-mode.md) call), the `intoLiveTurn` branch
  through `pushTurn`/`pushTurnSafely`/`pushWithToken`
- `server/src/index.ts` — the `interjectQueued` case
- `server/src/workerClient.ts` — `linkOpen` getter
- `web/src/lib/transcript.ts` — the `'interject'` `TranscriptItem` case in `buildTranscript`,
  `reuseItem`, `foldAgentTurns`'s boundary list
- `web/src/components/Transcript.tsx` — `InterjectionRow` (outlined, not `UserBubble`)
- `web/src/components/QueuedMessages.tsx` — the Send now action, its disabled states and tooltips
- `server/scripts/spike-interject.ts` — the throwaway measurement harness this feature's `priority`
  choice came from; kept as living evidence, not wired into any build

## Important symbols

- `SessionManager.canInterject(sessionId)` — is there a turn running right now that this bridge
  can safely join: `status === 'running'`, not compacting/interrupting/rewinding/mid-workflow-
  advance, a query this bridge knows it spawned (`queryTokens`), and the worker link open *now*
  (`linkOpen`, not the optimistic `status.connected`)
- `SessionManager.interjectQueued(sessionId, queuedId, { actor, needsApproval })` — the owner
  gate first (before anything is removed, emitted, or pushed), then item lookup, then the
  attachments refusal, then `canInterject`; on success: remove the item, clear `queuePaused` only
  if the queue is now empty, emit an `'interject'` transcript event attributed to `item.actor`,
  push with `priority: 'next'` into the live query
- `pushTurn`/`pushTurnSafely(meta, message, { intoLiveTurn })` — `intoLiveTurn` skips token
  resolution and reuses `queryTokens.get(meta.id)` as-is; a normal push that saw a rotated token
  would `closeQuery` first, which would kill the very turn the interjection is joining
- `SessionManager.pushIntoLiveTurn(meta, text)` — the exact `pushTurnSafely(..., { intoLiveTurn:
  true })` call this feature makes, extracted to a private helper so a second caller (plan
  comments delivered on approval, see [permissions-and-plan-mode](permissions-and-plan-mode.md))
  does not duplicate the `priority: 'next'` measurement or its rationale. `interjectQueued` is
  still the first and only caller that also removes a queue item and clears `queuePaused`; the
  second caller has no queue item to remove.
- `InterjectData` — `{ text, mentions?, actor? }`; no `source` field, unlike `'user'` — an
  interjection is always human-authored
- `WorkerClient.linkOpen` — `this.ready && ws.readyState === OPEN`, deliberately not
  `status.connected` (which stays optimistic for `WORKER_LOST_MS` after a real disconnect)

## Data flow

### The measurement that decided `priority`

`server/scripts/spike-interject.ts` opens a bare streaming-input query (no MCP, no hooks,
`settingSources: []`), starts a turn that runs ten `sleep 3`s one at a time, and at t+6s pushes a
second message asking the model to stop and reply with a sentinel string. Three runs per arm
against CLI 2.1.260:

| arm | `priority` | `result` count | steered inside the turn |
|---|---|---|---|
| A | *(absent)* | 1 | yes |
| B | `'now'` | 2 | no |
| C | `'next'` | 1 | yes |
| D | `'next'`, pushed while parked in `canUseTool` | unmeasured (gate never held in the recorded run) | — |

`priority: 'now'` does not steer inside the turn. It makes the CLI end the running turn at its
next safe point (right after the in-flight tool's `tool_result`) and start a **second** query —
observable as a second `system:init` and a second `result`. Because the turn's last real content
was a bare user text block (not a `tool_result`, no trailing assistant text), the CLI's own
turn-well-formedness check fails and it synthesizes `error_during_execution` — this is the exact
mechanism behind the `[ede_diagnostic] result_type=user last_content_type=n/a` string a live
session showed during development. A failed synthetic result on top of a healthy turn also parks
a workflow step as failed.

`priority: 'next'` and omitting `priority` both measured identically (one result, steered inside
the turn, roughly 1.2s after the tool call already running returned). `'next'` was kept over
omitting the field because a CLI too old to know it silently drops it and falls back to the same
behaviour arm A measured — so shipping `'next'` needs no `MIN_INTERJECT_VERSION` floor.

No echo of the pushed message ever came back as a `type: 'user'` message on the stream in any
arm, so `handleSdkMessage` persists nothing extra for it (a possibility Phase 0 of the original
plan flagged and ruled out).

Arm D is the open question: whether `waiting-permission` (the CLI parked inside `canUseTool`)
drains stdin at all. The one recorded run never exercised the gate (ambient settings
auto-approved the tool before `settingSources: []` was added to the spike), so
`canInterject` refuses whenever the session is not `'running'` — including
`waiting-permission` — until this is actually measured.

### The release itself

1. Client sends `interjectQueued`; `MESSAGE_AUTHZ` requires the `prompt` cap (same as
   `editQueued`), gated before any handler runs.
2. `interjectQueued` refuses first on `needsApproval` — the check this table cannot express: a
   guest whose prompts are held for review must not release their own by pressing Send now.
3. Then item lookup, then attachments (refused in v1 — see Business rules), then `canInterject`.
   A `canInterject` failure returns `code: 'settled'`, not an error: the item is left queued and
   `maybeFlush` is about to send it the ordinary way the moment the turn ends — the same product
   behaviour that existed before this button.
4. On success: the item leaves the queue, an `'interject'` transcript event is written attributed
   to `item.actor` (not the clicker), and the message is pushed with `priority: 'next'` reusing
   this query's spawn-time token.
5. The client renders the new event as `InterjectionRow` — human-authored like a bubble, but
   outlined rather than filled (it opened no turn) and with no Edit/Delete-from-here (it is not a
   rewind anchor: `rewindSession` truncates from a `kind: 'user'` seq, and there is nothing
   mid-turn to rewind to).

## Dependencies

- [session-collaboration](session-collaboration.md) — the queue, `editQueued`/`cancelQueued`,
  `MESSAGE_AUTHZ`, and attribution (`item.actor`) this feature reuses rather than reinventing
- [transcript-rendering](transcript-rendering.md) — the bubble convention `InterjectionRow`
  deliberately departs from, and the `foldAgentTurns`/subagent-nesting rules it must not disturb
- [workflow-step-lifecycle](workflow-step-lifecycle.md) — why an interjection during
  `workflow?.advancing` is refused (`consolidateStepOutput` is already reading the turn)
- [context-window](context-window.md) — why an interjection during a manual compaction is refused
- [permissions-and-plan-mode](permissions-and-plan-mode.md) — `waiting-permission` exclusion,
  shared with that feature's "never opens a turn boundary" rule

## Tests

- `server/src/sessions.queue.test.ts` `describe('interjectQueued')` — delivers into the live turn
  with `priority: 'next'` and no new `'user'` event; runs as the item's author, not the clicker;
  leaves `turnSource`/`turnStartedAt`/`turnActor`/`status`/`interruptedAt`/`workflow` untouched;
  never calls `close` on the worker stub (the token-rotation regression detector); the rest of the
  queue is untouched and un-flushed; `queuePaused` survives a partial release and clears when the
  queue empties; `idle`/`done`/`waiting-approval` all return `settled` with the item still queued;
  `needsApproval: true` is refused with nothing emitted; an item with attachments is refused with
  its staged file still on disk; an unknown id is refused; a closed worker link refuses rather
  than buffering into a future query
- `server/src/sessions.compact.test.ts` — refused (`settled`) while a manual compaction's `running`
  status is covering the session
- `server/src/sessions.turns.test.ts` — an interjection does not split `collectTurns`' turn count;
  a step slice containing one is still a single turn; `scanTurnActivity` is unchanged by one
- `server/src/messageAuthz.test.ts` — `interjectQueued` follows `prompt` (denied at `view`, allowed
  at `prompt`); the `promptNeedsApproval` refusal itself is asserted in the queue test, not here

## Business rules

- Sending only ever happens from the queue row, never from the composer — typing while the
  session is busy still queues exactly as before.
- An interjection never opens a turn and is never a rewind anchor.
- It runs attributed to the item's author, not whoever pressed Send now.
- A `promptNeedsApproval` guest cannot release their own held item — the owner still must.
- Items with attachments are refused in v1: the staged files would need re-reading into a
  multi-block `content` array mid-turn, and their only cleanup path today is `cancelQueued`'s
  `fs.rmSync`.
- Refused during compaction, an in-flight interrupt, a rewind, or a workflow force-advance, and
  when the worker link is not open right now — in every case the item stays queued and flushes
  normally once the turn settles.
- Releasing one item never releases the rest of the queue, and never clears `queuePaused` unless
  the queue is now empty.
- Interjected work bills to the original turn's single `result`, so a workflow step's cost
  includes whatever ran after the interjection — correct for that one turn, but less comparable
  across runs.
- No `MIN_INTERJECT_VERSION`: the measured behaviour for `priority: 'next'` and for an absent
  `priority` is identical, so there is no version floor to gate on.

## Architectural rules

- `'interject'` is a separate `TranscriptEvent`/`TranscriptItem` kind, not a flag on `'user'`.
  Every turn-boundary scan keys on `kind === 'user'` — `withoutCompactSpans`, `collectTurns`,
  `recordFilesChanged`, `lastPromptForRetry`, `lastAssistantText`, `summarizeTurn`, and
  `foldAgentTurns` — and all of them stay correct untouched only because an interjection is a
  different kind.
- The push reuses `queryTokens.get(sessionId)` instead of resolving a fresh access token, because
  `pushWithToken` closes the query on a token mismatch — resolving fresh would risk ending the
  very turn the interjection is joining.
- No new `SessionStatus` value and no new `SessionMeta` field: the transcript event is the entire
  record of an interjection having happened.
- `priority` rides inside the opaque `push.message` the worker already forwards verbatim
  (`BridgeToWorker.push.message: unknown`), so `worker.ts` and `PROTOCOL_VERSION` are untouched.
- `interjectQueued`'s `{ ok: false; code: 'refused' | 'settled' }` union mirrors
  `compactContext`'s existing return shape: a lost race reads as "still queued", not as an error.
- `WorkerClient.linkOpen` exists because `status.connected` is deliberately optimistic
  (`WORKER_LOST_MS`) for a UI badge — the one caller that must not have its message silently
  buffered into a future, unattributed query needs the pessimistic answer instead.
- The CLI's `priority` behaviour and the choice of `'next'` come from a measurement
  (`server/scripts/spike-interject.ts`), not an inference from the SDK's type declarations — kept
  as a script rather than deleted so the table above can be reproduced against a newer CLI.

## Related decisions

- [session-collaboration](session-collaboration.md) — the queue, `MESSAGE_AUTHZ`, and attribution
  this feature is built on top of; gains the `interjectQueued` row and the "author, not releaser"
  note in that document's own narrative.
- [transcript-rendering](transcript-rendering.md) — gains the rule that `InterjectionRow` is the
  only human-authored transcript row that is not a bubble and carries no rewind actions.
- [workflow-step-lifecycle](workflow-step-lifecycle.md) — `workflow?.advancing` as a refusal
  condition.
- [context-window](context-window.md) — compaction as a refusal condition.
- [turn-recovery](turn-recovery.md) — why a failed turn's Retry still re-sends the original
  prompt, never an interjection that was delivered into it.
- [permissions-and-plan-mode](permissions-and-plan-mode.md) — the sibling "never opens a turn
  boundary" rule; `waiting-permission` excluded here for the same reason it is unresolved there.

## On a codex session

Send now maps to `turn/steer`, which delivers into the turn already running. The protocol
carries an `expectedTurnId` precondition, so steering a turn that has already moved on fails in
the worker rather than landing in the wrong one — which is also why `canInterject` does not
demand a `queryTokens` entry for codex. That map is the Claude token store and a codex session
never fills it, so the check would have refused every Send now here.

The capability is `interject` in `shared/providers.ts`; a provider that cannot be steered hides
the button rather than disabling it, because there is no state the user could reach that would
enable it. See [openai-codex-sessions](openai-codex-sessions.md).
