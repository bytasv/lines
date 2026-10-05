# Transcript live-update performance

Covers: batching WebSocket transcript events, keeping rebuilt transcript items referentially
stable, windowing a long transcript's initial mount, and paged transcript loading.

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

A fourth, related symptom: opening a session could sit on an empty transcript indefinitely with
no way to tell "still loading" from "dead" — the composite of a slow bridge wake-up and a message
that silently never arrived (below).

## Entry points

- `web/src/store.ts` (`applyServerMessage`, `case 'event'`, `flushPendingEvents`)
- `web/src/components/Transcript.tsx` (the tail window, `showEarlier`, `revealWorkflowStep`
  handling)
- `web/src/components/SessionView.tsx` (the `loadTranscript` send/retry effect, the backfill
  effect, `TranscriptLoading`)
- `server/src/transcriptPage.ts` (`pageTranscript`), `web/src/lib/transcriptPage.ts`
  (`mergeTranscriptPage`), `web/src/lib/transcriptBackfill.ts` (`requestRest`)

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

### Loading a transcript, and why it used to look dead

`SessionView` sends `{ type: 'loadTranscript' }` once per session, gated on `!loaded &&
health.connected` (deps include `health.connected`, not just `sessionId`/`loaded`) rather than
merely `!loaded`. `ws.ts`'s `send()` drops any non-prompt message outright when the session's own
link is down; with the old `!loaded`-only gate, a `loadTranscript` sent while the link was still
reconnecting was silently dropped and `loaded` never became true — nothing re-sent it, so the
transcript stayed on the empty-state copy forever until the user re-picked the session. Keying the
effect on `health.connected` re-fires it on every reconnect instead.

While `!loaded && !events?.length` (nothing loaded, nothing cached from a previous load to show
meanwhile), `SessionView` renders `TranscriptLoading` in place of `<Transcript>` — a `Loader` plus
one reason line, in priority order: link down ("Connecting to …"), bridge not attached
(`linkedMachineHealth(...).block`), worker not connected ("Machine's worker is restarting…"), else
"Loading transcript…". Past `SLOW_LOAD_MS` (8s) since the request went out, a dimmed hint and a
manual Retry button (re-sends `loadTranscript`) appear alongside it. A reconnect reload — `loaded`
false but `events` already cached from before — never shows this block; the transcript stays on
screen throughout.

### Paged load

A long transcript as one `transcript` frame (largest measured: 5540 events / 14.2 MB) crossed the
relay E2E-encrypted, so it could not be compressed, and was `JSON.parse`d on the phone in one go
before anything rendered. The tail window only limits *rendering*, so it did not help. The load is
now paged: the recent tail first, then older history in the background.

- **Protocol.** `loadTranscript` takes an optional `page`. Absent = the whole file in one frame,
  exactly as before. `page: {}` = the tail page. `page: { before: S }` = the page of events with
  `seq < S`. `all: true` (only with `before`) = everything older than `before` in one frame, for
  jump and reveal targets. The `transcript` reply carries an optional `page: { floor, prevSeq }`:
  `floor` is the file's first seq, `prevSeq` the seq of the last event *not* sent (null when the
  page reaches the start). A reply with no `page` is complete.
- **Page budget and turn alignment** (`pageTranscript`, server-side, pure and separate from
  `index.ts`, which listens on import). A page is walked backward from the end (or from `before`)
  until `PAGE_BYTES` of raw line text, then extended back to the nearest `user` event so a turn is
  not split. Extension stops at 4 × `PAGE_BYTES` and cuts mid-turn, so one huge workflow turn
  cannot defeat paging; `buildTranscript` already tolerates orphaned events. A page always holds at
  least one line, so the backfill loop always advances. Seqs are read off the line prefix, with a
  per-line `JSON.parse` fallback when the prefix does not match.
- **Background driver.** `SessionView` sends `page: {}` for the initial load and retry (and
  `main.tsx` for the deep-link load). While the open session has `transcriptHasMore` (cached first
  seq above `transcriptFloor`), it requests `{ before: firstSeq }` one page at a time, on every
  device, so the client converges to the complete transcript. The in-flight guard
  (`transcriptBackfill.ts`) is keyed by `before`, is shared with the jump/reveal fetches
  (`requestRest`), and is cleared on disconnect. Only the open session backfills.
- **Merge and gap rule** (`mergeTranscriptPage`, called from `case 'transcript'`). Dedupe by seq,
  then sort, as before; older pages simply prepend. A tail page whose `prevSeq` is newer than the
  last cached seq is disjoint from the cache (a long disconnect), so the cache is dropped instead
  of leaving a hole, and backfill re-fetches it. `transcriptLoaded` is set by any page, so first
  paint happens on the tail. `transcriptFloor` resets with `transcriptLoaded` on `hello` and on
  session delete; a complete reply clears it.
- **Version skew.** An old bridge ignores `page` and replies without it, which the client treats
  as complete; an old client sends no `page` and gets the whole file. No error path is needed.
- **Partial lists.** Until backfill finishes, `buildTranscript` sees a suffix of the events and
  cross-turn derivations are transient (see [transcript-rendering](transcript-rendering.md)). The
  progress bar's started steps count every step up to the highest started one.
- The total bytes downloaded are unchanged; the win is time to first paint. The server's `PERF`
  log reports page bytes and `prevSeq` for measuring it.

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
- `loadTranscript` is re-sent on every reconnect, not just once per session — the send is gated on
  `health.connected`, not merely on `!loaded`, since a send while the link is down is dropped
  rather than queued (unlike a `prompt` message).
- The loading placeholder only replaces `<Transcript>` when there is nothing cached to show
  (`!loaded && !events?.length`); a reconnect reload with cached events keeps the transcript on
  screen instead of blocking it.
- A transcript load is paged: the tail paints first and older history backfills in the background,
  one byte-bounded page in flight at a time, on every device until the cache reaches the file's
  floor.
- A request with no `page` still gets the whole transcript, and a reply with no `page` is treated
  as complete, so old clients and old bridges keep working.
- A tail page that does not connect to the cached events replaces them rather than leaving a hole.
- The loading reason's precedence is link, then bridge attachment, then worker health, so a merely
  reconnecting link is never reported as "offline" — the same precedence order the machine-health
  banners use.

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

- Paging helpers must stay pure and out of `index.ts` (it listens on import) and out of the store
  (the driver lives in `SessionView` and `transcriptBackfill.ts`, since `ws.ts` already imports the
  store).
- The backfill's in-flight guard is module state shared by the background driver and the jump and
  reveal fetches, so they cannot race each other; it is keyed by `before`, which a reply moves.
- A `before` page is cut by `seq`, and a mid-turn cut is allowed only at the 4 × `PAGE_BYTES` cap.

## Related decisions

- [transcript-rendering](transcript-rendering.md) — `reconcileItems`, the row memos, the tail
  window's interaction with `updateProgress`, and the markdown highlight deferral.
- [workflow-step-lifecycle](workflow-step-lifecycle.md) — the stepper's jump-to-step going through
  `revealWorkflowStep`/`REVEAL_STEP_EVENT` so it still works against a windowed transcript.
- [session-and-project-ui](session-and-project-ui.md) — the sidebar half of the same symptom.
