# @mention support in prompts

## Purpose

Let the user type `@` in the composer to reference a documented feature or a project file, inline in the prompt text, without leaving the textarea.

## Entry points

- `web/src/components/Composer.tsx`
- `web/src/components/MentionInput.tsx`

## Files

- `web/src/components/MentionInput.tsx` (text/range state, atomic pill editing, caret snapping, hover card, mirror-div pill rendering)
- `web/src/components/MentionAutocomplete.tsx` (popover list, debounced search, keyed on `cwd` + a joined `roots` string)
- `web/src/lib/mentions.ts` (pure helpers, feature/file providers)
- `web/src/lib/files.ts` (`searchFiles`, `fetchTree` — WebSocket calls backing the file provider)
- `server/src/fileSearch.ts` (`searchFilesAcross`, `FileHit` — multi-root, globally-ranked file-name search)
- `server/src/fileRoutes.ts` (`find`/`file`/`tree` handlers, reached over the WebSocket — see [file-routes-over-ws](file-routes-over-ws.md))
- `server/src/workspacePaths.ts` (`workspaceRoots`/`resolveWorkspacePath`/`resolveWorkspaceParam`)
- `shared/types.ts` (`PromptMention`, `FindResponse`)
- `web/src/components/Transcript.tsx`, `web/src/components/QueuedMessages.tsx` (mention badges on sent/queued messages)

## Symbols

- `MentionInput`, `MentionValue`, `MentionRange`
- `findMentionToken`, `diffEdit`, `remapRanges`, `snapCaretOut`, `buildExpandedPrompt`, `uniqueMentions`
- `mentionProviders`, `MentionProvider` (search context is now `{ cwd, roots }`, not just `cwd`), `MentionCandidate`
- `searchFiles(root, query, limit)` / `searchFilesAcross(roots, query, limit)` — `web/src/lib/files.ts`'s WebSocket client and `server/src/fileSearch.ts`'s ranker share the `searchFiles` name; the ranker's multi-root entry point is `searchFilesAcross`

## Data flow

Typing `@query` opens a composer-anchored popover. Two providers run in parallel: the feature provider matches against `docs/codebase/index.json` (fetched live via a `file` request, and stays primary-root-only — see [multi-root-projects](multi-root-projects.md)); the file provider either browses one directory via a `tree` request (bare `@` or a query ending in `/`) or searches every root of the active project by name via a `find` request, which takes one path per root and 403s if any fails to resolve. A non-primary hit's `id`/expansion is the absolute path (`${root}/${rel}`); a primary-root hit keeps the bare `rel`, unchanged from before multi-root.

Selecting a candidate inserts an inline pill: a `MentionRange` (`start`/`end` character span) layered over the plain-text prompt. A mirror `<div>`, absolutely positioned behind a transparent-background `<textarea>`, paints pill backgrounds under the corresponding characters — the textarea itself stays a plain native input, so typing/caret/selection/IME/undo are all native behavior. Ranges are kept valid across edits by diffing old vs. new text on every keystroke and shifting/dropping ranges accordingly (`remapRanges`); editing inside a range dissolves it back to plain text.

On send, `buildExpandedPrompt` appends one reference block to the prompt text (feature name + doc path + entry points, or a file path) — this expanded text is what actually reaches the agent. The structured `mentions[]` (`kind`/`id`/`label`/`detail`) rides along on the WS message as a display-only sidecar, rendered as badges in the transcript and queued-message views; it is never parsed or resolved server-side.

## Tests

None.

## Business rules

- Mentions are resolved client-side and expanded into plain prompt text before the message leaves the browser — the server and worker never see or resolve `mentions[]`; they only see the already-expanded text, identically for a live send, a queued (offline) send, and a workflow's first prompt.
- A stale feature/file reference (moved path, renamed feature) produces a stale-but-harmless text block rather than blocking send — `docs/codebase/index.json` is documented as possibly-stale, so mention resolution is best-effort, not a correctness guarantee.
- The `find` project file search respects `.gitignore` (backed by `git ls-files`), falling back to a bounded directory walk outside a git repo, capped at 20,000 candidate files.

## Architectural rules

- New mention kinds are added by registering one more `MentionProvider` in `mentionProviders` — no switch-over-kind exists elsewhere in the composer or transcript code.
- Pill state (`MentionRange[]`) is a derived view kept in sync with the authoritative plain-text string via prefix/suffix diffing, not a second source of truth or a separate rich-text document model.
- No contenteditable and no rich-text editor dependency — pills are a cosmetic overlay (mirror div) behind a plain `<textarea>`.
- `find`, `file`, `tree`, and `docs` (see [docs-reader](docs-reader.md)) are dispatched from one place (`handleFileRequest` in `server/src/fileRoutes.ts`) and share one workspace-root restriction (`resolveWorkspacePath`, now in `server/src/workspacePaths.ts`), so a new file-serving route can't accidentally skip that check. `resolveWorkspacePath` also allows a path outside every root when it resolves inside a plan directory (`isPlanPath`) — see [permissions-and-plan-mode](permissions-and-plan-mode.md) — so a mention's `file`/`tree` reads inherit that one exception too.

## Related decisions

- [multi-root-projects](multi-root-projects.md)
