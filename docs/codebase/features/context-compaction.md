# Context compaction

## Purpose

Let the user manually compact a session's context (summarize the conversation so far and
replace it, freeing window space) from the app, and passively warn when a session is near its
context limit — without ever auto-firing compaction on the user's behalf. Also surfaces the
CLI's own background auto-compaction (which already runs today via `settingSources`) as a
readable transcript event instead of an opaque dropped message.

## Entry points

- `ContextWindowIndicator`'s "Compact now" button (in its hover-card dropdown).
- Passive near-limit warning badge on the same indicator (composer toolbar).

## Important files

- `shared/types.ts` — `ContextCompactRecord`, `ContextCompactData`, `SessionMeta.contextCompact`,
  `ClientMessage` (`compactContext`), `CONTEXT_WARN_PCT`, `effectiveContextTokens`,
  `contextCompactBlock`, `canCompactContext`
- `server/src/sessions.ts` — `withoutCompactSpans`, `extractCompactBoundary`,
  `extractCompactStatus`, `SessionManager.compactContext`, `SessionManager.abandonCompaction`,
  `SessionManager.resetClaudeSession`, the `compact_boundary`/`status` branches in
  `handleWorkerEvent`
- `server/src/index.ts` — `compactContext` client-message handler
- `web/src/lib/transcript.ts` — `'context-compact'` event → `ContextCompactItem`
- `web/src/components/Transcript.tsx` — `ContextCompactMarker`
- `web/src/components/ContextWindowIndicator.tsx` — `CompactButton`, near-limit badge

## Important symbols

- `contextCompactBlock(meta)` — single predicate (server guard + button `disabled` + tooltip)
  deciding whether compaction can run right now, with a `{ code, reason }` explaining why not.
- `effectiveContextTokens(meta)` — occupancy reading that self-corrects onto
  `contextCompact.postTokens` once a compaction (manual or the CLI's own auto-compaction) lands
  after the last measured turn.
- `withoutCompactSpans(events)` — strips a compaction (and its transcript markers) from a
  transcript slice before any turn scan.
- `SessionManager.compactContext(sessionId)` — the manual trigger.
- `extractCompactStatus(msg)` — reads an SDK `system`/`status` message's `compact_result`
  (`'success' | 'failed'`) and `compact_error`; this is the authoritative outcome of a manual
  compaction, unlike the mere absence of a `compact_boundary`.

## Data flow

Manual compaction does not go through `prompt()`. `compactContext` checks
`contextCompactBlock`, marks the session `running`, emits a `'context-compact'`
`{phase:'requested'}` transcript event, and pushes a user turn whose sole content block is the
literal text `/compact` through the existing worker `push()` path — the same mechanism the CLI's
own `/compact` slash command dispatches through (`supportsNonInteractive` + `post-text`
dispatch). This is reverse-engineered from the CLI binary, not a published SDK contract, so
nothing downstream assumes it works.

`handleWorkerEvent` watches every message for an SDK `system`/`compact_boundary`
(`extractCompactBoundary`), which arrives for both a manual and the CLI's own background
auto-compaction (already enabled via `settingSources: ['user','project']`). On a boundary:
`SessionMeta.contextCompact` is written (`{at, trigger, preTokens, postTokens?, ok:true}`), a
`'context-compact'` `{phase:'done'}` event is emitted, and every context-usage reading already
collected in that turn is discarded (`LiveState.compactedInTurn`) since it may describe either
side of the boundary.

`handleWorkerEvent` also watches for an SDK `system`/`status` message carrying a
`compact_result` (`extractCompactStatus`) while a manual compaction is in flight — this is the
authoritative pass/fail verdict, not an inference from a missing boundary. `'success'` (a
boundary-less success) writes `contextCompact` with `ok:true`, same as a boundary. `'failed'`
writes `ok:false` plus the SDK's own `compact_error` text, and this is the *only* thing that
flips `contextCompactBlock` to its `unsupported` code — the button disables with the SDK's own
explanation in the tooltip. If the pushed turn instead settles at `result` with neither a
boundary nor a status verdict having arrived, the outcome is inconclusive, not unsupported:
`abandonCompaction` closes the transcript span (so scans aren't left inside an open span
forever) but writes no `contextCompact` record, leaving the button enabled for the next
attempt.

The browser renders `'context-compact'` transcript events as a divider line ("Compacting…",
then upgraded in place to "Compacted: X → Y tokens" or an error), and the indicator recomputes
its ring/warning from `effectiveContextTokens` on every `SessionMeta` update.

## Dependencies

- The SDK's undocumented `/compact`-via-prompt-text dispatch (see Purpose/Data flow) — can
  silently change or disappear in a future `@anthropic-ai/claude-agent-sdk` bump.
- `SDKStatusMessage` (`system`/`status`, carrying `compact_result`/`compact_error`) — the
  authoritative pass/fail signal for a manual compaction; also undocumented as a contract,
  though the type itself ships in the SDK's `.d.ts`.
- [[context-window-inspector]] — the occupancy readings this feature corrects and warns against.

## Tests

- `server/src/sessions.compact.test.ts` — `withoutCompactSpans` (matched span, unmatched
  `requested` bounded to the next `user` event not end-of-array, findStepStart/collectTurns
  same-array regression), `extractCompactBoundary`, `extractCompactStatus`,
  `effectiveContextTokens` precedence, `contextCompactBlock` per block code, and the latch
  lifecycle (a silent turn writes no record, an explicit SDK failure/success does, a fresh CLI
  conversation clears a latched verdict).

## Business rules

- Lines never fires compaction itself — only a manual button and a passive warning badge. It is
  an irreversible, lossy, billable operation; timing is a judgement call left to the user. This
  is distinct from the CLI's own background auto-compaction, which Lines does not control and
  may or may not fire on its own schedule (see [[context-window-inspector]]).
- The manual button is disabled whenever `contextCompactBlock` returns non-null, and the
  tooltip always states which of five reasons applies: a turn is running, a workflow step is
  parked awaiting approval, the session has never run a turn, there is no occupancy reading yet,
  or the SDK explicitly reported the compaction as failed (`unsupported`, carrying the SDK's own
  error text when one was given).
- The `unsupported` latch requires an explicit SDK `compact_result: 'failed'` — a turn that
  settles with neither a boundary nor a status verdict is inconclusive and leaves the button
  enabled. The latch is also scoped to the CLI conversation that produced it: it is cleared on
  `resetClaudeSession`, on bridge-process restart (a previous process's verdict proves nothing
  about this one), and when a synced session adopts a remote update — so a genuinely unsupported
  setup re-latches on the next attempt rather than staying disabled forever.
- A workflow step parked `waiting-approval` blocks the manual button (compacting out from under
  a pending step would corrupt its hand-off) but does not block the CLI's own background
  auto-compaction from firing and self-correcting the ring.
- A compaction is invisible to every workflow turn scan (`consolidateStepOutput`,
  `lastAssistantText`, `summarizeTurn`, `retryTurn`) — it carries no `'user'` event of its own,
  so an unstripped span would register as a spurious extra "attempt" whose output is the
  compaction summary, corrupting the `{previous}`/`{outputs.*}` hand-off between steps.
  Permission bookkeeping (`unresolvedPermissionIds`, `expireUnresolvedPermissions`) does not
  strip compact spans — every permission event must stay visible there regardless.

## Architectural rules

- `compactContext` is a dedicated `SessionManager` method, not a call to `prompt()` — a
  compaction is not a user turn (no auto-naming, no queue interaction, no `'user'` transcript
  event).
- One shared predicate (`contextCompactBlock`) backs the server-side guard, the button's
  `disabled`, and its tooltip, rather than three independent conditionals that could drift.
- Naming: transcript event kind `'context-compact'`, its payload `ContextCompactData`,
  `SessionMeta.contextCompact` — all `contextCompact`-prefixed, distinct from the unrelated
  `compactionLevel` (transcript display density) already in `UserUiSettings`.
- The browser's `buildTranscript` (`web/src/lib/transcript.ts`) mirrors the server's
  `withoutCompactSpans`: while a `'requested'` marker is open, every event but the matching
  `'done'` (or the next `'user'` event, bounding a crash mid-compaction) is dropped from the
  rendered transcript, not just hidden by the marker pair — otherwise a `/compact` that
  dispatched as ordinary prompt text leaks the model's literal reply into the timeline. A
  failed `result` (`isFailedResult`) is a third exception, alongside `'user'`: the server
  has already abandoned the span by the time that result is emitted, so the client lets it
  through too, rather than swallowing the only failure row Retry can key off — see
  [turn-failure-retry](turn-failure-retry.md).

## Related decisions

- [turn-failure-retry](turn-failure-retry.md) — the failed-result escape from an open
  compaction span on the client, so a turn that failed mid-compaction still gets a
  Retry-able failure row.
