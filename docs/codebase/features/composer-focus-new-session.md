# Composer focus on new session

## Purpose

When a brand-new session is created, focus the prompt textarea automatically so the user can type immediately without clicking into it.

## Entry points

- `web/src/components/Composer.tsx`

## Files

- `web/src/components/Composer.tsx`
- `web/src/store.ts` (`sessionUpsert` auto-select-on-create)
- `shared/types.ts` (`SessionMeta.createdAt`)

## Symbols

- `Composer` (`textareaRef`, focus effect)

## Data flow

`store.ts`'s `sessionUpsert` handler auto-selects a session when it's new and `Date.now() - session.createdAt < 5000`. `Composer` re-runs a focus effect keyed on `session.id` and reuses the same 5-second heuristic to decide whether to call `.focus()` on the textarea ref — so it only fires for genuinely new sessions, not on every session switch.

## Tests

None.

## Business rules

- Focus fires only when the session is younger than 5 seconds (shared threshold with the store's auto-select logic); switching to an older existing session does not steal focus.

## Architectural rules

- Reuses the store's existing `justCreated` 5s threshold instead of introducing a new "is this session new" flag or protocol field.

## Related decisions

None.
