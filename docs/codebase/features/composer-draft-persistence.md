# Composer draft persistence

## Purpose

Persist the in-progress (unsent) prompt — text, `@mention` pills, and staged attachments — per session, so a page reload or a bridge/server restart never loses what the user was composing.

## Entry points

- `web/src/components/Composer.tsx`

## Files

- `web/src/store.ts` (`readDraft`, `writeDraft`, `pruneDrafts`, `readDraftAttachments`, `writeDraftAttachments`, `pruneDraftAttachments`)
- `web/src/components/Composer.tsx`
- `web/src/lib/mentions.ts` (`MentionValue` — the persisted text/mentions shape)

## Symbols

- `readDraft`, `writeDraft`, `pruneDrafts` (`store.ts`) — text + mention ranges, `localStorage`
- `readDraftAttachments`, `writeDraftAttachments`, `pruneDraftAttachments` (`store.ts`) — staged files, IndexedDB
- `Composer` (draft-seeded state, mirror-to-storage effects for both)

## Data flow

`Composer` seeds its prompt state from `readDraft(session.id)` via a lazy `useState` initializer — `SessionView` keys `Composer` by session id (`App.tsx` keys `SessionView` itself the same way), so switching sessions remounts the component and the initializer runs fresh per session. An effect writes the full draft back to `localStorage` (key `lines.drafts`, a `Record<sessionId, MentionValue>`) on every change.

Staged attachments follow the same remount-per-session shape but load asynchronously: a mount-only effect calls `readDraftAttachments(session.id)` against IndexedDB (database `lines-drafts`, object store `attachments`, keyed by session id) and seeds `attachments` state once it resolves; a `attachmentsLoaded` ref gates the mirror-to-storage effect so it can't fire with an empty array and wipe the stored draft before that load completes. `readDraftAttachments`'s callback only applies the loaded value if state is still empty, so a file staged in the brief window before load resolves is never clobbered.

Sending a message resets both the prompt and attachments state, which clears both drafts on the next mirror-effect run. On each `hello` from the server, `pruneDrafts` and `pruneDraftAttachments` remove drafts for sessions that no longer exist.

## Dependencies

- `@mention` pill data model (`MentionValue` = `{ text, ranges }`) from `web/src/lib/mentions.ts` — see feature docs/index entries covering `@mentions` if present.
- Browser IndexedDB, for staged attachments only.

## Tests

None (repo has no test runner; verified manually via reload).

## Business rules

- The persisted text draft is the full `MentionValue`, not plain text — restoring a draft must keep its `@mention` pills and expansions intact, not just the raw characters.
- Staged attachments persist across reload too; they live in IndexedDB rather than `localStorage` because base64 file/image data routinely runs tens of MB, well past typical `localStorage` quotas.
- An empty text draft (`text === ''`) or empty attachment list deletes its storage entry rather than storing an empty one.

## Architectural rules

- Text draft storage follows the existing single-JSON-map-under-one-key convention used elsewhere in `store.ts` (e.g. `lines.openFiles`), rather than one `localStorage` key per session.
- Attachment draft storage uses IndexedDB instead of `localStorage` for the same reason attachments themselves are staged as raw base64 client-side — size, not structure, is the deciding factor.

## Related decisions

None.
