# Quick file open (Cmd+P)

## Purpose

Jump to any project file from anywhere in the app via Cmd/Ctrl+P, without going
through the sidebar file tree — the same ranked file search backing `@mention`,
in a floating palette.

## Entry points

- `web/src/components/FilePalette.tsx`
- `web/src/App.tsx` (mounted as a global overlay, alongside the preview modal
  and login modal)

## Files

- `web/src/components/FilePalette.tsx` — hotkey, debounced search, keyboard
  nav, "Hide ignored" toggle
- `web/src/lib/files.ts` — `searchFiles(roots, query, limit, includeIgnored)`
- `server/src/fileSearch.ts` — shared ranker, see
  [prompt-mentions](prompt-mentions.md)
- `server/src/fileRoutes.ts` — `find` handler's `includeIgnored` param;
  `tree` handler's per-entry `ignored` mark
- `shared/types.ts` — `FileRequestParams.includeIgnored`, `TreeEntry.ignored`
- `web/src/store.ts` — `hideIgnored`/`setHideIgnored` (persisted, shared with
  the sidebar file tree)
- `web/src/components/FileTree.tsx`, `web/src/components/Sidebar.tsx` — the
  same toggle and dimming applied to the sidebar's file tree

## Symbols

- `FilePalette`
- `useHotkeys` (`@mantine/hooks`) registering `mod+P`
- `hideIgnored`, `setHideIgnored` — `web/src/store.ts`
- `includeIgnored` — `FileRequestParams`, threaded through
  `searchFiles`/`searchFilesAcross`
- `TreeEntry.ignored`

## Data flow

`mod+P` opens the palette from anywhere the hotkey is live — session view,
files mode, the docs reader, even while focused in the composer textarea or
the Monaco preview (`tagsToIgnore: []`, `triggerOnContentEditable: true`). It
searches `rootsForCwd(projects, activeProject)` through the same
`searchFiles` → `find` → `searchFilesAcross` path `@mention`'s file provider
uses (debounced, sequence-guarded), so ranking and query normalization are
identical between the two. Selecting a hit opens it in the existing
full-screen preview overlay (`openFilePreview`) rather than a files-mode tab,
so the palette works mid-session and from the docs reader without displacing
the session pane.

With no project open (or as a guest with no folder access) the hotkey no-ops
without calling `preventDefault`, so the browser's own Cmd+P (print) still
fires.

`hideIgnored` is one persisted boolean read by both the palette and the
sidebar `FileTree`: off, `searchFiles`/`fetchTree` results are unfiltered and
gitignored entries render dimmed; on (the default), the palette passes
`includeIgnored: false` and gitignored files drop out of both search and
browsing, and the tree filters out dot/ignored nodes client-side from data it
already has (no refetch on toggle). The bridge marks every tree entry's
`ignored` status itself (one `git check-ignore --stdin` call per directory
listing) so the toggle never needs a round trip.

## Dependencies

- `@mantine/hooks`' `useHotkeys`.
- The `find`/`tree` routes and `resolveWorkspacePath` root containment — see
  [file-routes-over-ws](file-routes-over-ws.md).
- `openFilePreview` / the Monaco preview overlay — unchanged, reused as-is.

## Tests

- `server/src/fileSearch.test.ts`, `server/src/fileRoutes.test.ts` — the
  shared search/tree behavior this feature depends on (`includeIgnored`,
  `ignored` marks, dotfile candidates).
- None yet directly on `FilePalette.tsx` — the web package has no test runner.

## Business rules

- Cmd+P searches only the active project's roots (`rootsForCwd`), not every
  open project tab.
- A hit always opens in the preview overlay, never a files-mode tab,
  regardless of which sidebar mode is active when the palette opens.
- `hideIgnored` defaults to on and is local-only (not part of synced
  settings) — a per-browser view choice, not a project setting.

- The candidate list is capped; non-ignored files fill the cap before ignored
  ones, so a large gitignored tree cannot starve the palette (or
  [find-in-files](find-in-files.md), which reuses the list).

## Architectural rules

- The palette is a global overlay mounted in `App.tsx` alongside
  `MonacoPreviewModal`/`LoginModal`, not scoped under any route — the
  shortcut has to work from the docs reader too.
- `hideIgnored` is a single store field read by both surfaces (palette,
  sidebar tree) rather than two independent toggles, so turning it off in one
  place doesn't leave the other showing a stale set.

## Related decisions

- [prompt-mentions](prompt-mentions.md) — the ranker, query normalization,
  and `find`/`tree` routes this feature reuses unchanged
- [multi-root-projects](multi-root-projects.md) — `rootsForCwd`, the roots
  the search spans
- [file-routes-over-ws](file-routes-over-ws.md) — transport for `find`/`tree`
