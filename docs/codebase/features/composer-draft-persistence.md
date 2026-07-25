# Composer draft persistence

## Purpose

Persist the in-progress (unsent) prompt per session in `localStorage`, so a page reload or a bridge/server restart never loses text the user was typing.

## Entry points

- `web/src/components/Composer.tsx`

## Files

- `web/src/store.ts` (`readDraft`, `writeDraft`, `pruneDrafts`)
- `web/src/components/Composer.tsx`
- `web/src/lib/mentions.ts` (`MentionValue` — the persisted shape)

## Symbols

- `readDraft`, `writeDraft`, `pruneDrafts` (`store.ts`)
- `Composer` (draft-seeded state, mirror-to-storage effect)

## Data flow

`Composer` seeds its prompt state from `readDraft(session.id)` via a lazy `useState` initializer — `SessionView` keys `Composer` by session id, so switching sessions remounts it and the initializer runs fresh per session. An effect writes the full draft back to `localStorage` (key `lines.drafts`, a `Record<sessionId, MentionValue>`) on every change. Sending a message resets the composer state, which clears the draft on the next write. On each `hello` from the server, `pruneDrafts` removes drafts for sessions that no longer exist.

## Dependencies

- `@mention` pill data model (`MentionValue` = `{ text, ranges }`) from `web/src/lib/mentions.ts` — see feature docs/index entries covering `@mentions` if present.

## Tests

None (repo has no test runner; verified manually via reload).

## Business rules

- The persisted draft is the full `MentionValue`, not plain text — restoring a draft must keep its `@mention` pills and expansions intact, not just the raw characters.
- Attachments are never persisted (base64 blobs are too large for `localStorage`); only the text/mention draft survives a reload.
- An empty draft (`text === ''`) is deleted from storage rather than stored as an empty entry.

## Architectural rules

- Draft storage follows the existing single-JSON-map-under-one-key convention used elsewhere in `store.ts` (e.g. `lines.openFiles`), rather than one `localStorage` key per session.

## Related decisions

None.
