# Find in files (Cmd+Shift+F)

## Purpose

Search the contents of every file in the active project, IDE-style, from the
sidebar's search panel. It is the Files scope of the shared sidebar search; the
session scopes are described in [session-search](session-search.md).

## Entry points

- `web/src/components/Sidebar.tsx` — the search input, scope toggle, hotkeys
- `web/src/components/FileSearchPanel.tsx` — `FileSearchResults`
- `server/src/contentSearch.ts` — `grepFilesAcross`

## Important files

- `server/src/fileRoutes.ts` — the `grep` route
- `server/src/fileSearch.ts` — `candidates(root)`, the file list shared with
  Cmd+P
- `shared/types.ts` — `buildMatcher`, `clipAround`, `GrepHit`, `GrepResponse`,
  `MatchOptions`
- `web/src/lib/files.ts` — `grepFiles`
- `web/src/store.ts` — `fileSearch`, `searchPreview`, `openSidebarSearch`
- `web/src/components/FilesView.tsx` — `SearchPreviewView`, `FileContentView`
  (the preview is editable)
- `web/src/lib/language.ts` — `isMarkdownPath`
- `web/src/components/Markdown.tsx` — Preview body for markdown files
- `web/src/App.tsx` — swaps the main pane to the preview

## Important symbols

- `grepFilesAcross(roots, query, opts)`
- `buildMatcher(query, opts)` — case, whole-word and regex flags; throws
  `SyntaxError` on a bad regex
- `SearchPreview` `{ path, line, col }`
- `FileContentView`, `useMarkdownMode`, `isMarkdownPath`

## Data flow

Cmd/Ctrl+Shift+F opens the sidebar search on the Files scope from anywhere,
including the composer. The web client sends a `grep` file request (debounced,
sequence-guarded) with the active project's roots and the flags. The bridge lists
candidate files with the same cached `candidates` list as Cmd+P, reads each file,
and returns per-file hits with clipped line text and match offsets. The panel shows
one header per file, then its matching lines with highlights.

Clicking a line sets `searchPreview`; the main pane shows that file at the line
while the results stay in the sidebar. Closing the preview, closing the search,
or switching to a session scope clears it.

## Dependencies

- The `fileRequest` transport — see [file-routes-over-ws](file-routes-over-ws.md)
- [file-quick-open](file-quick-open.md) — the candidate list and `hideIgnored`
- [multi-root-projects](multi-root-projects.md) — `rootsForCwd`

## Tests

- `server/src/contentSearch.test.ts`
- `server/src/sessionSearch.test.ts` — also covers `buildMatcher`/`clipAround`
- `server/src/fileRoutes.test.ts` — `grep` containment (403) and invalid regex (400)

## Business rules

- The preview can be edited and saved (Cmd/Ctrl+S or Save; owner only, Raw/Monaco
  only). Picking another file's hit, closing the preview or the search, or
  leaving the Files scope asks before dropping unsaved changes. After a save, the
  current query re-runs if the saved file is among the hits, since the edit may
  have shifted their line numbers.
- A hit on a markdown file opens in Raw at its line, not Preview, because a hit carries a line and a line only exists in the source. The header toggle switches to Preview; picking another hit returns to Raw. The choice is not persisted.
- Searches only the active project's roots, like Cmd+P.
- The eye toggle is the same `hideIgnored` as Cmd+P and the file tree; on by
  default, so gitignored files are excluded.
- Files over 1 MB and binary files are skipped.
- Results are capped by files with hits, total matches and wall-clock time; a
  capped response is marked `truncated` and the UI says so.
- Like `find`, `grep` is all-or-nothing across roots: one root outside the
  caller's reach is a 403 rather than a partial list.
- An invalid regex is a 400 with an `invalidRegex` body, shown as "Invalid regular
  expression."; a bare 400 means an older bridge without the route.
- Results are shown only while they match the current query, roots and flags, so
  a stale reply is never displayed under a newer search.

## Architectural rules

- The search reuses the file-request handler, so auth, the encrypted relay
  channel and root containment are inherited, not reimplemented.
- The server search and the web highlighting share `buildMatcher`, so what is
  highlighted is exactly what matched.
- Search runs on the bridge and yields to the event loop between batches of files;
  it must never block turn handling.
- Non-ignored files fill the candidate cap before ignored ones. Otherwise
  gitignored trees (such as dev-runtime snapshots) starve search and Cmd+P of
  real files.

## Related decisions

- [session-search](session-search.md)
- [file-routes-over-ws](file-routes-over-ws.md)
- [file-quick-open](file-quick-open.md)
