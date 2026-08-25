# Transcript live-update performance

Covers: batching WebSocket transcript events, keeping rebuilt transcript items referentially
stable, and windowing a long transcript's initial mount.

## Purpose

Switching sessions, or coming back to the browser tab from another app, used to freeze the UI for
a noticeable beat. The suspect was inefficient transcript rendering — row count, or a rebuild that
was too slow. Measured against real sessions (one at 5540 events / 14.2 MB), that premise was
wrong: `buildTranscript` + `foldAgentTurns` + `reconcileItems` together cost 3–5 ms even at that
size. The actual costs were:

- **A live turn re-rendering per WebSocket event** instead of per frame — a long streaming answer
  or a tool-heavy turn could commit dozens of times a second.
- **A hidden tab's backlog replaying as N sequential renders on refocus**, because React's
  scheduler throttles a hidden tab but the socket keeps delivering frames and each one used to call
  `set()` immediately.
- **A cold session-switch mount committing every row's Markdown in one synchronous pass.** A
  278-row folded session can hold ~90 full `Markdown` documents (user prompts + standalone
  answers); each is a synchronous remark → rehype → `rehype-highlight` parse, and `App.tsx` keys
  `SessionView` by `selectedSessionId`, so a switch is a clean remount, not an incremental update.
- **The sidebar re-rendering every row on every selection change**, independent of the size of the
  session being switched to — see [session-and-project-ui](session-and-project-ui.md) for that
  half; it explains why *small* sessions were slow to switch to as well.

`react-window` (or similar list virtualization) was considered and rejected — see
[transcript-rendering](transcript-rendering.md)'s architectural rules for why (it would break the
workflow progress bar's marker scan, the scroll-anchored auto-pin, and find-in-page). The fixes
here instead: batch events into one render per frame, make a rebuild cheap enough for React to skip
re-rendering unchanged rows, and window the initial mount instead of trimming row cost further.

## Entry points

- `web/src/store.ts` (`applyServerMessage`, `case 'event'`, `flushPendingEvents`)
- `web/src/components/Transcript.tsx` (the tail window, `showEarlier`, `revealWorkflowStep`
  handling)

## Data flow

1. A `'event'` server message pushes onto a per-session pending buffer (`pendingEvents`, a
   `Map<sessionId, TranscriptEvent[]>` closed over inside the store's `create()`) and schedules a
   flush via `requestAnimationFrame`. No `set()` happens here.
2. `flushPendingEvents()` applies every buffered session in one `set()`: it dedupes by building a
   single `Set<seq>` from the existing array per session, and replicates the pre-existing
   supersede rule (a complete, non-`stream_event` SDK message drops the streaming deltas that built
   up to it) once over the whole batch, at its *last* complete message's index — which produces the
   same resulting array the old per-event rule would have.
3. `requestAnimationFrame` does not fire in a hidden tab, so the buffer simply accumulates there; a
   `visibilitychange` listener flushes immediately on refocus, turning the backlog into one commit
   instead of a replay. A `setTimeout` fallback exists only for an environment with no `rAF` at
   all — it must not become a second, always-on drain path, or a hidden tab would flush on its own
   and defeat the point.
4. Every other message type flushes the buffer first, at the top of `applyServerMessage` — so
   `case 'transcript'`, `case 'hello'`, and the session-delete path always see a settled
   `transcripts` array.
5. On the render side, `Transcript.tsx` keeps a tail window over the folded item list (last ~40
   top-level items on mount) and grows it on idle or on scrolling near the top, with a "Show
   earlier messages" button as the explicit affordance. `reconcileItems` (see
   [transcript-rendering](transcript-rendering.md)) gives an unchanged rebuilt item back its
   previous object identity, which is what lets the row-level `memo`s and the `toolDiffCache`
   WeakMap actually skip work across a rebuild instead of recomputing everything from scratch.

## Business rules

- A live turn's transcript renders at most once per animation frame, not once per WebSocket event.
- A hidden tab accumulates its transcript backlog without rendering at all, and commits it as a
  single render on refocus rather than replaying the whole backlog as sequential renders.
- A long session's initial mount renders only its last ~40 top-level items; the rest backfill on
  idle, or immediately on scrolling near the top, with a "Show earlier messages" button as the
  always-available affordance.
- Windowing applies to workflow sessions too, not just plain ones; the progress bar and the
  stepper's jump-to-step both stay correct against a clipped list — see
  [transcript-rendering](transcript-rendering.md) and
  [workflow-step-lifecycle](workflow-step-lifecycle.md).

## Architectural rules

- **Contract:** nothing outside `applyServerMessage` may read `transcripts`/`lastEventAt` and
  assume it is settled. Every non-`'event'` message flushes the pending buffer first
  (`flushPendingEvents()` at the top of `applyServerMessage`'s switch). A new message handler added
  later that reads `transcripts` without going through this switch breaks the contract silently.
- `case 'event'` only pushes into the per-session pending buffer and schedules a flush; it performs
  no `set()` itself. The buffer, its scheduled-flush handle, and `flushPendingEvents` all live
  inside the store's `create()` closure, since they need to close over `set`.
- The flush's dedupe (one `Set<seq>` per session, built once per flush) and its supersede rule (a
  complete SDK message drops the stream deltas before it) must keep producing the same resulting
  array the old per-event path did — this is the only place either rule is expressed now.
- A `setTimeout` fallback for the flush arms only when `requestAnimationFrame` is unavailable. It
  must never arm merely because the tab is hidden — a hidden-tab timer firing would defeat the
  backlog-until-refocus behavior that batching on `rAF` exists for.
- `reconcileItems` is what makes a rebuild cheap for *React*, not `buildTranscript` itself —
  `buildTranscript`'s own cost was measured at 3–5 ms even on a 5540-event/14 MB real session, so
  it was never the dominant cost of a session switch. See
  [transcript-rendering](transcript-rendering.md) for the exhaustive list of fields
  `reconcileItems` has to compare.
- The tail window and the markdown highlight deferral (`Markdown.tsx`, documented in
  [transcript-rendering](transcript-rendering.md)) are the two changes that actually addressed the
  measured session-switch cost — windowing bounds how many `Markdown` documents mount at once, and
  the highlight deferral cuts the cost of each one that does.
- The sidebar's own re-render cost (`SessionRow` memoization, archived-session pagination — see
  [session-and-project-ui](session-and-project-ui.md)) is a second, independent contributor to
  "switching sessions feels slow" that has nothing to do with the size of the session being
  switched to: unmemoized, it re-rendered every row on every selection change regardless.

## Related decisions

- [transcript-rendering](transcript-rendering.md) — `reconcileItems`, the row memos, the tail
  window's interaction with `updateProgress`, and the markdown highlight deferral.
- [workflow-step-lifecycle](workflow-step-lifecycle.md) — the stepper's jump-to-step going through
  `revealWorkflowStep`/`REVEAL_STEP_EVENT` so it still works against a windowed transcript.
- [session-and-project-ui](session-and-project-ui.md) — the sidebar half of the same symptom.
