# Auto-mode guard allowlist

## Purpose

Makes the auto-mode guard's "Always allow" exceptions visible and editable in
Settings instead of an invisible, append-only local file, and syncs the list
across a user's machines through the storage server — without ever letting a
remote change apply silently, since the list controls what Auto mode is allowed
to run without asking.

## Entry points

- Settings modal, "Auto-mode allowlist" pane (nav rail item, deep-linked when a
  review is pending) — list, remove, hand-add an entry.
- Permission card "Always allow" — the existing write path, now going through the
  same normalization and change notifications as the UI.
- Allowlist-changed-elsewhere review modal, mounted at the app root (not inside
  Settings) so a divergence reaches the user even if they never open the gear.

## Important files

- `shared/types.ts` — entry/blob/review types, `normalizeAllowEntry` and the other
  validators, the `addGuardAllow`/`removeGuardAllow`/`reviewGuardAllowlist` and
  `guardAllowlist`/`guardAllowlistReview` wire messages.
- `server/src/autoGuard.ts` — `GuardAllowlist` (CRUD, load-time migration, the
  review lifecycle); re-exports `ALWAYS_ASK_TOOLS`/`GuardAllowEntry` from
  `shared/types.ts` for existing importers.
- `server/src/store.ts` — `GuardSyncState`, `loadGuardSync`/`saveGuardSync`
  (`guard-allowlist-sync.json`, separate from the bare-array `guard-allowlist.json`).
- `server/src/sessions.ts` — `resolvePermission`'s "Always allow" branch.
- `server/src/sync.ts` — `pushGuardAllowlist`, the isolated `/guard-allowlist` pull.
- `server/src/userContext.ts` — wires `guard.onChange`/`guard.onReview` to
  broadcast + push, and calls `reviewRemote` before the push block in `syncNow`.
- `server/src/index.ts` — `hello` fields, the three message cases.
- `storage/prisma/schema.prisma`, `storage/src/index.ts` — the `guard_allowlist`
  table and its `GET`/`PUT /guard-allowlist` endpoints.
- `web/src/store.ts` — `guardAllowlist`/`guardReview` state, actions, message cases.
- `web/src/components/GuardAllowlistSection.tsx`,
  `web/src/components/GuardAllowlistReviewModal.tsx`, `web/src/lib/guardEntries.ts`.

## Important symbols

- `normalizeAllowEntry(raw)` — the single validation gate every writer (permission
  card, Settings form, load migration, remote ingest) runs an entry through;
  returns the canonical entry or a `GuardEntryError`.
- `diffAllowlists(local, remote)` / `sameAllowEntry` — set-based comparison used
  both for divergence detection and for the review's added/removed lists.
- `GuardAllowlist.reviewRemote(remote)` — stages, updates, or clears a pending
  review; never mutates the live entries.
- `GuardAllowlist.acceptReview()` / `rejectReview()` — the only two ways a pending
  review resolves.
- `GuardAllowlist.blob()` — entries plus the `updatedAt` that orders the storage
  row; distinct from the set-difference comparison used to detect divergence.

## Data flow

A local change (permission card "Always allow", or a Settings add/remove) calls
`GuardAllowlist.add`/`remove`, which persists, fires `onChange`, and — unless a
review is currently pending — pushes the new blob to the storage server.

On connect/reconnect, `syncNow` pulls `/guard-allowlist` and calls
`guard.reviewRemote(pulled.guardAllowlist)` *before* pushing local state up. If the
remote list (after re-validation) differs from the local one, a review is staged
and broadcast as `guardAllowlistReview`; the entries themselves are untouched.
`hello` also carries the current list and any pending review, so a fresh page load
or bridge restart shows the banner/modal immediately rather than waiting on the
next pull.

The user resolves the review by accepting (installs the remote list verbatim) or
rejecting (keeps the local list, but bumps its `updatedAt` so it now wins the
storage row's last-write-wins and gets pushed back over the remote one).

## Dependencies

- Storage server `guard_allowlist` table, one JSON blob per user (see
  [agent-memory-sync](agent-memory-sync.md) for the precedent this follows and the
  row-per-item alternative it explicitly does not need at this scale).
- Depends on `ALWAYS_ASK_TOOLS` and the Bash-prefix matching in `assessToolCall`
  (see [plan-file-auto-approve](plan-file-auto-approve.md), which shares this file).
- Uses the same shared-label idiom as
  [permission-mode-selector](permission-mode-selector.md).

## Tests

- `server/src/autoGuard.allowlist.test.ts` — validator rules (through
  `assessToolCall`, not just string comparison), CRUD, and the load-time migration.
- `server/src/autoGuard.sync.test.ts` — the review lifecycle: staging, set-equal
  clearing, invalid-entry filtering, accept/reject, reject-remembered-by-content,
  and restart persistence.
- `server/src/sessions.alwaysAllow.test.ts` — the permission-card write path.
- `server/src/store.test.ts` — `loadGuardSync`/`saveGuardSync` round-trip.

## Business rules

- A remote allowlist is never applied automatically; every divergence is shown to
  the user as an explicit added/removed diff before anything changes.
- Divergence is detected as a set difference between local and remote entries, not
  by comparing `updatedAt` — a fresh machine's empty list is otherwise "newer" than
  a populated cloud row and would silently erase it.
- Pushing the local list to storage is suppressed while a review is pending, so the
  push itself can't destroy the state being reviewed.
- Rejecting a review keeps the local list, remembers the rejection keyed on the
  remote's *content* (so the same proposal is never re-asked), and pushes the
  local list back over the remote row.
- `ALWAYS_ASK_TOOLS` (`AskUserQuestion`, `ExitPlanMode`) can never be allowlisted —
  the guard checks that set before consulting the allowlist at all, so such an
  entry would be a UI lie about what it does.
- A hand-typed Bash prefix is whitespace-collapsed the same way a permission
  card's prefix is, and may not contain `&`, `&&`, `||`, `;`, or `|` — those are
  exactly the operators `assessToolCall` splits a command on.
- Non-Bash entries never carry a `prefix`; one is silently dropped rather than
  rejected, matching the shape the guard's tool-name match actually compares.

## Architectural rules

- Validators live in `shared/types.ts`, not `server/src/autoGuard.ts`, so the web
  client runs the exact same rules before ever sending an entry to the bridge.
- The allowlist is synced through dedicated `addGuardAllow`/`removeGuardAllow`/
  `reviewGuardAllowlist` intent messages, not folded into the whole-blob
  `UserUiSettings` save — the bridge also writes entries on its own (permission
  cards), so a whole-blob client save would have an unbounded race window to
  clobber them.
- The web store never caches the allowlist in `localStorage`; it is
  server-authoritative and arrives on every `hello`, so a cached copy would be a
  stale second source of truth for a security-relevant list.
- Removing an entry has no confirmation modal — it only narrows what the guard
  allows, so it fails safe. Guarding the safe direction while leaving the risky
  one (add) unguarded would train the wrong reflex.
- The review modal is mounted at the app root, not inside the Settings modal,
  because the requirement is that the user is notified of a divergence, not that
  they happen to open Settings.

## Related decisions

None recorded.
