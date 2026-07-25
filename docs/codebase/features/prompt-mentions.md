# @mention support in prompts

## Purpose

Let the user type `@` in the composer to reference a documented feature or a project file, inline in the prompt text, without leaving the textarea.

## Entry points

- `web/src/components/Composer.tsx`
- `web/src/components/MentionInput.tsx`

## Files

- `web/src/components/MentionInput.tsx` (text/range state, atomic pill editing, caret snapping, hover card, mirror-div pill rendering)
- `web/src/components/MentionAutocomplete.tsx` (popover list, debounced search)
- `web/src/lib/mentions.ts` (pure helpers, feature/file providers)
- `web/src/lib/files.ts` (`searchFiles`, `fetchTree` — HTTP calls backing the file provider)
- `server/src/fileSearch.ts` (`git ls-files`-backed project-wide file-name ranking)
- `server/src/index.ts` (`/find`, `/file`, `/tree` bridge routes; per-request CORS)
- `shared/types.ts` (`PromptMention`, `FindResponse`)
- `web/src/components/Transcript.tsx`, `web/src/components/QueuedMessages.tsx` (mention badges on sent/queued messages)

## Symbols

- `MentionInput`, `MentionValue`, `MentionRange`
- `findMentionToken`, `diffEdit`, `remapRanges`, `snapCaretOut`, `buildExpandedPrompt`, `uniqueMentions`
- `mentionProviders`, `MentionProvider`, `MentionCandidate`
- `searchFiles` (both `web/src/lib/files.ts`'s HTTP client and `server/src/fileSearch.ts`'s ranker share this name)

## Data flow

Typing `@query` opens a composer-anchored popover. Two providers run in parallel: the feature provider matches against `docs/codebase/index.json` (fetched live via the existing `/file` route), the file provider either browses one directory via `/tree` (bare `@` or a query ending in `/`) or searches the whole project by name via the `/find` route.

Selecting a candidate inserts an inline pill: a `MentionRange` (`start`/`end` character span) layered over the plain-text prompt. A mirror `<div>`, absolutely positioned behind a transparent-background `<textarea>`, paints pill backgrounds under the corresponding characters — the textarea itself stays a plain native input, so typing/caret/selection/IME/undo are all native behavior. Ranges are kept valid across edits by diffing old vs. new text on every keystroke and shifting/dropping ranges accordingly (`remapRanges`); editing inside a range dissolves it back to plain text.

On send, `buildExpandedPrompt` appends one reference block to the prompt text (feature name + doc path + entry points, or a file path) — this expanded text is what actually reaches the agent. The structured `mentions[]` (`kind`/`id`/`label`/`detail`) rides along on the WS message as a display-only sidecar, rendered as badges in the transcript and queued-message views; it is never parsed or resolved server-side.

## Tests

None.

## Business rules

- Mentions are resolved client-side and expanded into plain prompt text before the message leaves the browser — the server and worker never see or resolve `mentions[]`; they only see the already-expanded text, identically for a live send, a queued (offline) send, and a workflow's first prompt.
- A stale feature/file reference (moved path, renamed feature) produces a stale-but-harmless text block rather than blocking send — `docs/codebase/index.json` is documented as possibly-stale, so mention resolution is best-effort, not a correctness guarantee.
- The `/find` project file search respects `.gitignore` (backed by `git ls-files`), falling back to a bounded directory walk outside a git repo, capped at 20,000 candidate files.

## Architectural rules

- New mention kinds are added by registering one more `MentionProvider` in `mentionProviders` — no switch-over-kind exists elsewhere in the composer or transcript code.
- Pill state (`MentionRange[]`) is a derived view kept in sync with the authoritative plain-text string via prefix/suffix diffing, not a second source of truth or a separate rich-text document model.
- No contenteditable and no rich-text editor dependency — pills are a cosmetic overlay (mirror div) behind a plain `<textarea>`.
- `/find`, `/file`, and `/tree` share one CORS helper (`corsFor()` in `server/src/index.ts`) and one workspace-root restriction (`resolveWorkspacePath`), so a new file-serving route can't accidentally skip either check.

## Related decisions

None.
