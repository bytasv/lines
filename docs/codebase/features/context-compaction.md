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
  `SessionManager.compactContext`, `SessionManager.abandonCompaction`, the `compact_boundary`
  branch in `handleWorkerEvent`
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
side of the boundary. If the pushed turn instead settles at `result` with no boundary having
arrived, `contextCompact` is written with `ok:false` — this is what flips
`contextCompactBlock` to its permanent `unsupported` code, disabling the button with an
explanatory tooltip instead of leaving it clickable-but-inert. An interrupted or crashed
compaction closes the transcript span (so scans aren't left inside an open span forever) but
writes no `contextCompact` record — neither proves the mechanism is broken.

The browser renders `'context-compact'` transcript events as a divider line ("Compacting…",
then upgraded in place to "Compacted: X → Y tokens" or an error), and the indicator recomputes
its ring/warning from `effectiveContextTokens` on every `SessionMeta` update.

## Dependencies

- The SDK's undocumented `/compact`-via-prompt-text dispatch (see Purpose/Data flow) — can
  silently change or disappear in a future `@anthropic-ai/claude-agent-sdk` bump.
- [[context-window-inspector]] — the occupancy readings this feature corrects and warns against.

## Tests

- `server/src/sessions.compact.test.ts` — `withoutCompactSpans` (matched span, unmatched
  `requested` bounded to the next `user` event not end-of-array, findStepStart/collectTurns
  same-array regression), `extractCompactBoundary`, `effectiveContextTokens` precedence,
  `contextCompactBlock` per block code.

## Business rules

- Compaction is never auto-fired by the app on the user's behalf — only a manual button and a
  passive warning badge. It is an irreversible, lossy, billable operation; timing is a judgement
  call left to the user.
- The manual button is disabled whenever `contextCompactBlock` returns non-null, and the
  tooltip always states which of five reasons applies: a turn is running, a workflow step is
  parked awaiting approval, the session has never run a turn, there is no occupancy reading yet,
  or compaction was already found unsupported in this session.
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

## Related decisions

None recorded.
