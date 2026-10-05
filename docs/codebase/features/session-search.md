# Find in sessions

## Purpose

Search the transcripts of a project's sessions from the sidebar, replace the
session list with the matching snippets, and jump to the hit in the transcript.

## Entry points

- `web/src/components/Sidebar.tsx` — search icon by the "Sessions" title,
  input, scope toggle (All sessions | This session | Files), hotkeys, Esc
- `web/src/components/SessionSearchResults.tsx` — results and the empty-state
  placeholder
- `server/src/sessionSearch.ts` — `searchableTexts`, `searchSession`

## Important files

- `server/src/fileRoutes.ts` — the `sessionSearch` route
- `shared/types.ts` — `SessionSearchHit`, `SessionSearchResponse`, `buildMatcher`
- `web/src/lib/files.ts` — `searchSessions`
- `web/src/store.ts` — `sidebarSearch`, `transcriptJump`, `jumpToTranscript`
- `web/src/lib/transcript.ts` — `findItemIndexForSeq`
- `web/src/components/Transcript.tsx` — scroll, pulse and text highlight

## Important symbols

- `searchSession(sessionId, events, match, limit)`
- `findItemIndexForSeq(items, seq, toolUseId?)`
- `TranscriptJump` `{ sessionId, seq, toolUseId?, query, nonce }`
- `SidebarSearchScope` — `'all' | 'session' | 'files'`

## Data flow

The search icon or Cmd/Ctrl+F opens the search over the session list; the title
stays "Sessions". The input takes the New session button's place. The query is
shared across scopes, so switching scope re-runs it. Nothing typed shows a
placeholder with the shortcuts.

The client sends a `sessionSearch` file request with the session ids the sidebar
lists for the project (or just the active one for "This session"). The bridge
extracts searchable text from each session's events, matches it, and returns
snippets per session, most recently updated first.

Clicking a snippet selects the session and sets `transcriptJump`. The transcript
maps the hit's event `seq` (and tool-use id) to a row, widens its render window
if the row is above it, scrolls it to the centre, pulses it and highlights the
matching text. A live turn does not pull the view back to the bottom during the
jump. A hit older than the first loaded event (history is still backfilling) triggers one
`loadTranscript` for everything older than it, and the jump completes when that lands.

Shortcuts: Cmd/Ctrl+F opens session search, or switches to All sessions from the
Files scope; Cmd/Ctrl+Shift+F opens Files ([find-in-files](find-in-files.md)).
Esc closes the search from anywhere, including the composer, unless another
handler took it, a Mantine overlay is open, or focus is in Monaco.

## Dependencies

- The `fileRequest` transport and `sessionInReach` — see
  [file-routes-over-ws](file-routes-over-ws.md) and
  [session-change-tracking](session-change-tracking.md)
- [transcript-performance](transcript-performance.md) — windowed mounting, which
  is why search is server-side

## Tests

- `server/src/sessionSearch.test.ts`
- `server/src/fileRoutes.test.ts` — owner, explicit ids, guest scope

## Business rules

- Searched: prompts, interjections, assistant text, key tool-input fields
  (command, paths, pattern, description) and tool results. Not searched:
  thinking, compacted spans, provider-switch seed prompts, ephemeral system
  events.
- Every session id is clamped through `sessionInReach`; a guest only finds what
  they can already read. It also requires the `readFiles` capability, because it
  rides the file-request gate.
- Results are capped per session, in sessions and in time, and marked
  `truncated`.
- Cmd+F replaces the browser's find-in-page while a project is open, because the
  transcript renders only its most recent rows. With no project, or on a phone,
  the browser keeps it.
- Old results are never shown while a new search is loading; results carry the
  query and session ids they answer.
- Text inside a folded turn or closed tool card gets the row pulse but no text
  highlight; a match spanning two text nodes is not highlighted.

## Architectural rules

- Search is an overlay state over the session list, not a sidebar mode; it is
  never persisted or synced.
- The transcript finds a hit's row from keys that already embed the event `seq`;
  items carry no separate `seq` field. Each row sits in a `display: contents`
  wrapper keyed for lookup.
- Highlighting uses the CSS Custom Highlight API, not DOM rewriting, so the
  transcript's markdown tree is untouched.

## Related decisions

- [find-in-files](find-in-files.md)
- [transcript-rendering](transcript-rendering.md)
- [transcript-performance](transcript-performance.md)
