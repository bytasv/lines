# Session collaboration

## Purpose

Invite another signed-in user into one session, or onto a whole machine, so they can prompt the
same running agent — with live presence (who is watching, who is typing) and attribution (whose
prompt is whose) — without ever getting their own copy of the host's data.

This inverts the app's original single-owner assumption: a browser reached a machine only when
`hub.ownerId === userId`, and the bridge resolved every connection to its own isolated
`UserContext`. Three things had to hold for that inversion to be safe:

- **A guest reaches the host's running session, not a copy.** Transcripts and turns are
  host-local; only `SessionMeta` syncs to Postgres. A guest connection resolves to the *host's*
  `UserContext` — never mints one of their own — or the transcript they see would be empty.
- **Access is a capability set, not a boolean.** A guest runs code on the host's machine, as the
  host's OS user, on the host's Anthropic token. Every grant carries a `ShareCaps` flag set,
  defaulting to the most restrictive preset (`view`).
- **A denial is enforced by the compiler, not by review.** `MESSAGE_AUTHZ` classifies every
  `ClientMessage['type']` in an exhaustive `Record`; a message type added later without a
  classification fails to compile.

Three share presets cover the UI (`view`, `prompt`, `collaborator`); the capability flags exist
underneath so a finer grant can ship later with no migration. Invites work by email (claimable
only by that address's *verified* Clerk email, so it works before the invitee even has an
account) or by a single-use link.

## Entry points

- Share button in the session header (`web/src/components/SessionView.tsx`) — owner only, hosted
  builds only (`SHARING_ENABLED`), opens `ShareModal` in session scope
- Share action on a machine row in Settings → Machines (`web/src/components/DevicesSection.tsx`)
  — owner-only (hidden on a `shared: true` row), opens the same `ShareModal` with no `session`
  prop, so it starts in machine scope. The reachable-from-two-places design is deliberate: the
  session-header button is easy to miss for someone who wants to hand over a whole machine rather
  than one conversation.
- `web/src/components/ShareModal.tsx` — presets, invite by email/link, member list, revoke; scope
  toggle only renders when a `session` was passed in
- `web/src/components/JoinPage.tsx` — `/join/:code`, the redeem flow including sign-up
- The pairing screen's "You've been invited" card (`web/src/components/ConnectMachine.tsx`) —
  discovers a pending invite by the caller's verified email, for someone who signs in without
  the link
- `POST /v1/shares/invite`, `GET /v1/shares`, `GET /v1/shares/pending`,
  `GET /v1/shares/invite/:code`, `POST /v1/shares/claim`, `PATCH`/`DELETE /v1/shares/:kind/:id`,
  `GET /v1/contacts`, `DELETE /v1/contacts/:email`, `DELETE /v1/contacts`
  (`storage/src/index.ts`)
- Settings → Collaborators (`web/src/components/CollaboratorsSection.tsx`) — the address book
  behind the share modal's email field: list, forget one, clear all
- `POST /v1/devices/authorize` — the relay's grant oracle, shared-secret gated, called only by
  the relay
- Every `ClientMessage` a guest can send — gated by `MESSAGE_AUTHZ` before any handler runs
  (`server/src/index.ts` `handleMessage`)
- `{ type: 'presence', sessionId, viewing, focused }` — sent by `web/src/lib/presence.ts`'s
  `usePresence` hook (debounced, plus a heartbeat)

## Files

- `shared/types.ts` — `ShareCaps`, `NO_SHARE_CAPS`, `SharePreset`, `ShareScope`,
  `SHARE_PRESETS`/`capsForPreset`/`parseShareCaps`/`presetOfCaps`, `ShareProfile`, `Actor`,
  `SocketAccess`/`OWNER_ACCESS`, `MessageAuthz`/`MESSAGE_AUTHZ`/`authorizeMessage`,
  `PresenceViewer`, the `hello.access` block, `SessionMeta.turnActor`, `QueuedPrompt.actor`,
  `QueuedPrompt.editedAt`/`editedBy`, `PermissionRequestData.resolvedActor`, the `presence`
  client/server messages, `ClientMessage.interjectQueued`, `InterjectData`
- `storage/prisma/schema.prisma` — `DeviceMember`, `SessionShare`, `ShareInvite`, `UserProfile`,
  `ShareContact` (the collaborator address book), `Device.online`
- `storage/src/shares.ts` — `authorizeDevice` (the relay's oracle body), `profileOf`,
  `revokeGrantsForDevice`, `capsJson`, `normalizeEmail`, `recordShareContact`,
  `forgetShareContact`
- `storage/src/presence.ts` — `presenceOf` (the `Device.online` freshness gate)
- `storage/src/index.ts` — the `/v1/shares/*` and `/v1/devices/authorize`/`presence` routes;
  `cacheProfile`/`verifiedEmails` (Clerk lookups); the unpair/revoke grant cascade; the
  `/v1/contacts` routes and the contact upsert on invite-mint and on claim
- `relay/src/authorize.ts` — `authorizeClient`, extracted for testing without a socket
- `relay/src/index.ts` — `handleClient`'s owner-fast-path/guest-grant branch,
  `reauthorizeGuests` (the `GUEST_REAUTH_MS` sweep), `reportPresence`
- `relay/src/mux.ts` — `Channel.grant`, `openChannel`'s grant param, `guestChannels`,
  `dropChannel`
- `relay/src/protocol.ts` — `AttestedGrant` on the `open` frame
- `server/src/relayClient.ts` — the bridge-side `AttestedGrant`/`AttestedIdentity` duplicate
  (deliberately not shared with `relay/`)
- `server/src/index.ts` — `handleConnection`'s guest-vs-owner resolution, `buildHello`, the
  `handleMessage` authz gate, `conns` (now carries `access`+`connId`), the `presence` case
- `server/src/userContext.ts` — `sockets: Map<BrowserLink, SocketAccess>`, `sessionIdOf`,
  `mayReceive` (the scoped broadcast fan-out), `PresenceTracker`
- `server/src/presence.ts` — `PresenceTracker`
- `server/src/userRegistry.ts` — `UserRegistry.peek` (never mints a context)
- `server/src/workspacePaths.ts` — `workspaceRoots`/`resolveWorkspacePath` clamped to a guest's
  granted session cwds; the `~/.claude/plans` auto-approve exception narrowed to owner-only
- `server/src/fileRoutes.ts` — every route takes `access`; `syncLog` is owner-only
- `server/src/sessions.ts` — `userPrompt`/`prompt` take an `actor`; `QueuedPrompt.actor`;
  `resolvePermission`/`logResolution` take an actor for `resolvedActor`; `editQueued` (rewrite a
  queued prompt in place — author or owner only, never clears `queuePaused`); `interjectQueued`
  (release one queued item into the running turn — see
  [turn-interjection](turn-interjection.md))
- `server/src/workflows.ts` — `startIfPending`/`iterateIfWaiting`/`runStep`/`runStepSafely` take
  an actor (a workflow-attached session intercepts a prompt *before* `userPrompt` ever runs)
- `web/src/lib/shares.ts` — the HTTP client for every `/v1/shares/*` route, `PRESET_COPY`,
  `ShareContact`, `listContacts`/`forgetContact`/`clearContacts` (the `/v1/contacts` routes)
- `web/src/lib/can.ts` — `useCan`, `useIsGuest`, `useInScope`, `useClaudeLoginNeeded` (guest UI
  narrowing, all reading the same `access` the bridge enforces)
- `web/src/lib/identityRule.ts` — `resolveIdentity` (pure), `personMeta`, the person palette
- `web/src/lib/identity.ts` — `useIdentityResolver` (binds the pure rule to the store + Clerk)
- `web/src/lib/presence.ts` — `usePresence`, `usePeers`
- `web/src/components/PresenceStack.tsx`, `PromptAuthor.tsx` — the avatar surfaces
- `web/src/components/QueuedMessages.tsx` — per-item author, "waiting for X" framing, the edit
  affordance (`QueuedEditor`, a `MentionInput` mount) and its "edited" badge
- `web/src/components/PermissionPrompt.tsx` — the resolved-card "approved by X" badge
- `web/src/components/CollaboratorsSection.tsx` — Settings pane over the same
  `/v1/contacts` client; list, forget one, clear all
- `web/src/components/DevicesSection.tsx` — the Share action on an owned machine row, second
  `ShareModal` entry point (machine scope, no `session` prop)

## Symbols

- `ShareCaps` — the flag set: `prompt`, `promptNeedsApproval`, `readFiles`, `interrupt`,
  `approvePermissions`, `manageWorkflow`, `setModel`, `setPermissionMode` (no preset grants
  this), `createSessions` (machine scope only)
- `parseShareCaps(value)` — reads a stored JSON blob back into `ShareCaps`, **failing closed**:
  anything missing, malformed, or not literally `true` is denied. The load-bearing case is a
  capability added after a grant was written — an old row must not silently acquire it
- `MESSAGE_AUTHZ: Record<ClientMessage['type'], MessageAuthz>` — every message classified as
  `owner`, `connection` (heartbeat/token relay, any connection may send it), `cap` (any grant
  holding it), `session` (session-scoped, `cap: null` means any grant including View only), or
  `machine` (machine-scope grants only)
- `authorizeMessage(msg, access)` — the one gate `handleMessage` consults before its switch; a
  denial names the missing capability rather than a bare "unauthorized"
- `SessionManager.editQueued(sessionId, queuedId, patch, editor)` — rewrites a queued prompt's
  text/mentions/draft/attachments in place; refuses an item that is not the editor's own unless
  they are the machine owner, and never touches `queuePaused` or the item's queue position
- `authorizeDevice(prisma, deviceId, userId)` — owner (fast, no share tables) → machine member →
  session shares (several intersect to the *narrowest*, never the union); a stale grant (the
  device was unpaired and re-claimed) is refused
- `normalizeEmail(value)` — trim + lowercase, shared by `ShareInvite.inviteeEmail` and
  `ShareContact.email` so the two can never disagree about what "the same address" means;
  blank normalizes to `null`, never `''`
- `recordShareContact(prisma, ownerId, email, userId?)` — upserts the address book row on invite
  mint and on claim; never fatal (catches and warns, like `cacheProfile`), and only ever fills
  `userId` in, never clears a name a prior claim earned
- `forgetShareContact(prisma, ownerId, email)` — hard delete, scoped by `ownerId`, so two
  accounts holding the same address never affect each other's list
- `authorizeClient` (relay) — deliberately stricter than the device `verifyDevice`: every
  non-answer (timeout, non-200, malformed body, an owner-shaped answer for a non-owner, a
  session grant with no sessions) denies, because this is an initial grant rather than
  protecting an already-established link
- `PresenceTracker` — keyed by connection, not user, so two tabs of one person are two viewers;
  never touches `SessionMeta`
- `resolveIdentity(ctx, userId, profile)` — pure attribution rule: resolves what "no actor"
  means first (the session's host — them, or you), then the record's own attested profile, then
  the host's cached profile, then a presence-learned one, then Clerk for yourself, then a stable
  shortened id. Never blank, never keyed on the name (so two unnamed people can't collapse to
  one colour)
- `Actor` — `{ userId, name, imageUrl }`, taken from the connection's attested identity, never a
  message body

## Data flow

### Minting and claiming a grant

`POST /v1/shares/invite` verifies the caller owns the device (and, for a session share, the
session) before minting a code. `POST /v1/shares/claim` is a compare-and-set on
`claimedBy: null` in the same transaction that writes the `DeviceMember`/`SessionShare` row, so a
replayed code 409s rather than minting a second grant. An email-bound invite is checked against
the claimer's *verified* Clerk emails — unverified never matches, or anyone could add the
invitee's address to their own account and claim in their place.

### The collaborator address book

Recorded at the two moments an owner learns a real address, and nowhere else — the book is not
derived from `listShares()`, because a claimed-then-revoked grant or an expired unclaimed invite
must still be offered back. `POST /v1/shares/invite` upserts a `ShareContact` when `inviteeEmail`
is set (a link-only invite records nothing yet — there is no address until someone claims it).
`POST /v1/shares/claim` upserts one on the invite's *owner*, keyed by `invite.inviteeEmail` when
present, otherwise the claimer's primary email just cached into `UserProfile` — this is what lets
a link invite still populate the book, and the only path that has a `userId` to attach. Both
writes are non-fatal, matching `cacheProfile`: a lagging migration or a slow write must not fail
an otherwise-valid invite or claim. `ShareModal` reads `GET /v1/contacts` alongside `GET
/v1/shares` and fails that half soft — a contacts fetch that errors leaves the suggestion list
empty rather than blanking the grant list.

### The relay gate

`handleClient`'s owner path (`hub.ownerId === userId`) is byte-for-byte unchanged and never
consults storage. Anyone else calls `authorizeClient`, which POSTs
`{ deviceId, userId }` to `/v1/devices/authorize` and gets back `{ allowed, ownerId, scope, caps,
sessionIds?, profile, viewer }` — `profile` is the host's identity for the guest's UI, `viewer` is
the *caller's own* identity, resolved server-side so presence/attribution can't be spoofed. A
grant additionally requires the bridge to speak `COLLAB_MIN_PROTOCOL`: an older bridge silently
drops the unknown `grant` field and would serve the guest as the owner, so the version check runs
before the grant lookup. That check (`DeviceHub.guestNeedsNewerBridge`) applies only while a
bridge is attached — with none, there is nothing to be too old, and refusing a guest for it would
be indistinguishable from a revoked grant instead of the offline state `openChannel` already
sends. The grant rides the `open` frame's optional fields, which is what lets this ship without a
`RELAY_PROTOCOL_VERSION` bump. `reauthorizeGuests` re-checks every live guest channel on
`GUEST_REAUTH_MS` (60s) and closes one whose grant narrowed or vanished; owner channels keep the
existing 300s device re-verify.

A guest channel is dropped, not replayed, when its device's bridge re-attaches
(`DeviceHub.attachAgent`). The new bridge's `hello` — and with it its app protocol — has not
arrived yet at replay time, so a bridge too old to understand `grant` would silently serve the
guest as the owner, exactly what the version check above exists to prevent. Closing the guest's
socket makes its browser reconnect and re-run the whole `/client` gate once the new bridge's
protocol is known. Owner channels are unaffected — they carry no grant to lose.

### The bridge resolves a guest to the host's context

`handleConnection` reads `attested.grant.hostUserId` and calls `registry.get(hostUserId)` — never
`registry.get(guestUserId)`. Two guards close the leak that would otherwise follow: a guest
connection never sets `ctx.clerkToken` and never calls `syncNow()`, and the relay's `onToken`
handler uses `registry.peek()` (never mints) instead of `registry.get()` for the same reason — a
guest's token arrives there too, every ~50s, from their browser's own auth relay.

`buildHello` gives a guest their sessions (scope-filtered), the machine's health, and
`access: { scope, caps, sessionIds?, ownerProfile, deviceId }` — and nothing account-wide:
`workflows`, `steps`, `recipes`, `usage`, `auth`, `settings`, `guardAllowlist`, `projects` are all
empty/omitted for a guest.

### The authz gate and scoped broadcast

`handleMessage` builds one `Actor` per connection (present for the owner too, not only guests —
see Attribution below) and calls `authorizeMessage(msg, access)` before its switch. A denial
replies `{type:'error', sessionId, message}` on the originating socket and logs one
`[share] denied …` line.

`UserContext.sockets` is `Map<BrowserLink, SocketAccess>`, not a `Set`. `broadcast` derives
`sessionIdOf(msg)` and calls `mayReceive(msg, sessionId, access)` per socket: a session-bearing
message reaches only sockets whose scope covers it; an account-wide message (no session id)
reaches the owner only, except `workerStatus`/`storageStatus` — a guest whose turns are about to
fail needs to know why, and neither carries anything private.

### Presence

`usePresence` sends `{type:'presence', sessionId, viewing, focused}` on a 250ms settle plus a
25s heartbeat, and an explicit `viewing: false` on unmount. `PresenceTracker.signal` is keyed by
connection id; moving to another session removes the connection from the old one in the same
call, so switching sessions leaves no ghost viewer behind. The broadcast (`{type:'presence',
sessionId, viewers}`) is session-bearing, so the existing scoped fan-out delivers it to exactly
that session's viewers — no new routing needed.

### Attribution

An `Actor` is built for *every* connection, owner included — the earlier design (actor only for
guests, "no actor" inferred as "the host") let the same message render as two different people
depending on who read it. `Actor.name`/`imageUrl` are null for the owner (the bridge has no Clerk
lookup for its own owner); the client fills those in from its own Clerk session.

The actor threads through `SessionManager.prompt`/`userPrompt` into the persisted `'user'`
transcript event and `SessionMeta.turnActor`. A workflow-attached session intercepts a prompt at
`startIfPending`/`iterateIfWaiting` *before* `userPrompt` ever runs — since most sessions run a
workflow, both had to take the actor too, or almost no prompt would ever be attributed. A
released queued prompt (`QueuedPrompt.actor`) credits the person who wrote it, not the owner who
released it.

A queued-but-unsent prompt can be edited in place before it flushes — the author may fix their own,
and the owner may edit anything in their queue (the review case: a guest's `promptNeedsApproval`
prompt, before it runs on the owner's machine as them). An edit by someone other than the author
stamps `QueuedPrompt.editedAt`/`editedBy` rather than passing silently, and the item still flushes
attributed to the original author, never the editor. `editQueued` is authorized at the `prompt`
cap, not the `interrupt` cap `cancelQueued` uses — rewriting your own not-yet-sent prompt is the
same authority as writing it, and a `prompt`-preset guest (the one whose prompts land paused) has
`prompt` but not `interrupt`. Editing never clears `queuePaused`: only an explicit send resumes a
paused queue, so an owner's edit of a pending prompt must not double as approving it.

This is a structurally different operation from [session-rewind](session-rewind.md)'s Edit
action, despite both landing text back in the composer: `editQueued` rewrites a prompt that has
not sent yet and is authorized at `prompt`; rewind's Edit discards an *already-sent* prompt
(and every reply and prompt after it) and is authorized at `interrupt`, the same cap as
`compactContext`. Neither generalizes to the other.

On the client, `resolveIdentity` is the single source every surface (presence avatars, prompt
bubbles, the queued-message list, the resolved-permission badge, the sidebar's turn-actor chip)
resolves a person through — so they can never disagree about who somebody is.

## Dependencies

- Clerk, for verified emails (invite binding) and each user's own name/avatar/id
- [hosted-machine-access](hosted-machine-access.md) — the device-verify/pairing machinery this
  extends; the relay's owner fast path is unchanged by this feature
- [multi-machine-client](multi-machine-client.md) — holding a shared machine's link alongside
  your own, and the session-row/composer differentiation for a remote session
- `web/src/lib/agents.ts` — `personMeta`'s palette is deliberately disjoint from `agentMeta`'s
  (asserted by a test reading both files as source)

## Tests

- `storage/src/shares.test.ts` — capability parsing (fail-closed), preset round-trips,
  `normalizeEmail`, and (opt-in on `STORAGE_TEST_DATABASE_URL`) the full grant matrix:
  owner/member/session-share/revoked/stale grant, intersection over union for overlapping
  session shares, unpair cascading to every grant, and the address book: mint/claim recording a
  contact, a repeat mint touching one row instead of duplicating, a revoked grant leaving the
  contact behind, a claim's `userId` surviving a later email-only mint, and `forgetShareContact`
  scoped by owner
- `storage/src/devices.presence.test.ts` — `presenceOf`'s freshness gate (the relay-crash case);
  the `/v1/devices/presence` route (opt-in)
- `relay/src/clientAuthorize.test.ts` — `authorizeClient` against every shape of non-answer; the
  `/client` socket gate with a junk/absent token
- `relay/src/agentHeartbeat.test.ts` — presence reports on attach/detach; a takeover never reports
  the live bridge offline
- `server/src/messageAuthz.test.ts` — the owner passes every message; a capability-less guest
  passes only `connection` and `cap: null` session reads; every never-grantable message stays
  owner-only at every preset/scope; a session-scoped guest cannot reach a sibling session;
  `editQueued` is allowed at the `prompt` preset and denied at `view`, the deliberate divergence
  from `cancelQueued`'s `interrupt`
- `server/src/sessions.queue.test.ts` — `editQueued`: text/mentions/draft replaced without moving
  the item or its `ts`; a mention-less draft is not persisted; editing never clears `queuePaused`;
  an edit by someone other than the author stamps `editedAt`/`editedBy`; attachment add/remove
  deltas (unlink on disk, `[...kept, ...staged]` ordering, a url outside the item's own refs is
  ignored); author-only / owner / no-actor-is-owner-only authority; an unknown id is refused
  leaving the queue untouched; emptying text with no attachments left is refused. Also covers
  `cancelQueued`'s attachment cleanup, previously untested
- `server/src/guestAccess.test.ts` — file-read clamp to granted session cwds, `~/.claude/plans`
  denied to a guest, traversal refused, `find` refuses a whole request rather than a partial
  result, `syncLog` owner-only
- `server/src/broadcastScope.test.ts` — `sessionIdOf` (including the `sessionUpsert` nested-id
  case), `mayReceive` for every message shape at every scope
- `server/src/presence.test.ts` — ghost-free session switching, two-tab independence, an
  identical heartbeat producing no broadcast
- `server/src/attribution.test.ts` / `attribution.identity.test.ts` — the actor is unconditional
  (not owner-conditional); every human-prompt entry point (`startIfPending`, `iterateIfWaiting`,
  `userPrompt`) is passed the actor; `resolveIdentity`'s fallback chain, including the "own
  avatar with no attested profile" and "recorded id resolves identically for any reader" cases

## Business rules

- Three presets: `view` (read only), `prompt` (queues paused for owner release, always with
  `readFiles`), `collaborator` (prompt/interrupt/approve/model/workflow, plus `createSessions` at
  machine scope). No preset ever grants `setPermissionMode` — it is the guard around every other
  capability.
- Never grantable at any preset: settings, the guard allowlist, project/worktree management,
  login/logout, device unpair, workflow/step/recipe authoring, `installUpdate`, `deleteSession`,
  `pickFolder`.
- A machine-scope grant covers every session on the machine and outranks a session share on the
  same machine.
- Several session shares on one machine intersect to the *narrowest* set of capabilities, never
  the union — a view-only session must never inherit a collaborator session's caps.
- Revoking a share, or unpairing/deleting the device, tombstones every `DeviceMember`/
  `SessionShare`/unclaimed `ShareInvite` on that device in one transaction. A device id is
  re-registerable, so a grant that outlived its device would attach to whoever claims that id
  next.
- A guest never gets a `UserContext` of their own on the host's machine, and never sets
  `clerkToken` or triggers `syncNow` — the host's sessions must never be pushed to Postgres under
  the guest's identity.
- A guest's file access is clamped to the cwds of the sessions their grant covers, never the
  host's whole project list; the `~/.claude/plans` auto-approve exception is owner-only.
- Revocation has a bound, up to `GUEST_REAUTH_MS` (60s), on an already-open guest socket.
- A `promptNeedsApproval` guest's prompt lands `queuePaused: true` on the owner's existing queue
  — no new state machine; the owner's own next send resumes it.
- A queued prompt may be edited in place before it flushes: the author may edit their own, and the
  machine owner may edit any item, but no one else. `editQueued` is authorized at the `prompt` cap
  — deliberately not `cancelQueued`'s `interrupt` — so a `prompt`-preset guest can still fix their
  own pending prompt. Editing never clears `queuePaused` or reorders the queue; an edit by someone
  other than the author is recorded (`editedAt`/`editedBy`), but the released prompt is still
  attributed to the author, not the editor.
- A queued prompt may also be released early, into the turn that is already running ("Send now" —
  see [turn-interjection](turn-interjection.md)), also authorized at `prompt`. Same attribution
  rule as an ordinary flush: it runs as the item's author, not whoever pressed the button. A
  `promptNeedsApproval` guest cannot use it on their own item — only the owner can release it,
  same as an ordinary approval.
- Presence and attribution identity always come from the connection's attested identity, never
  from a client-supplied message field.
- A historical row (or the owner's own prompt) with no recorded actor is attributed to the
  session's host — a pure read-side reinterpretation, not a migration.
- `switchProvider` sits at `cap: 'interrupt'` in `MESSAGE_AUTHZ`, the most destructive cap the
  table has, beside `compactContext`/`rewindSession` — it is strictly more destructive than
  either, dropping the conversation, changing the model, and injecting a turn. What the table
  cannot express (one row, one cap) is that it also needs the `setModel` cap, and that a guest
  whose prompts are held for review (`promptNeedsApproval`) must be refused outright, since the
  seed prompt it injects bypasses `userPrompt`'s approval staging. Both are the first lines of
  `SessionManager.switchProvider` — the same documented pattern `interjectQueued` already uses
  for the check this table cannot carry. See
  [cross-provider-model-switching](cross-provider-model-switching.md).
- The collaborator address book (`ShareContact`) is decoupled from grant state on purpose:
  revoking a share, letting an invite expire unclaimed, or the invite being claimed-then-revoked
  never removes the remembered address — that is exactly the case the book exists to survive.
  Removing a contact (one, or all) is a hard delete, not a tombstone; it only clears a
  suggestion and never touches a grant.

## Architectural rules

- `MESSAGE_AUTHZ` is an exhaustive `Record` keyed on `ClientMessage['type']` specifically so a
  message type added later without a classification is a **compile** error, not a review gap. Do
  not weaken it to a partial map or a lookup with a fallback.
- `SocketAccess` lives on the `sockets` Map's value, never on `BrowserLink` — that interface is a
  deliberately minimal structural contract (see `browserLink.test.ts`).
- The relay's owner fast path never touches storage; latency and failure surface for the
  overwhelmingly common case are unchanged by this feature.
- The relay holds no database credentials and no notion of capabilities — it forwards an opaque
  grant it never inspects, matching its existing "never parse an app message" rule.
- `parseShareCaps` denies by default on anything not an explicit `true`; a permissive default
  (spreading the stored blob over `NO_SHARE_CAPS`) would let a capability added later be
  silently inherited by every existing grant.
- Presence is bridge-local and ephemeral by design — it never rides `SessionMeta`, so it never
  writes to Postgres and needs no relay or storage support at all: every viewer of a session,
  owner and guest alike, is already on the same host `UserContext`.
- `resolvedActor` sits alongside `resolvedBy`, never folded into it: `resolvedBy` is
  provenance-of-decision (user vs. workflow-advance vs. recovery), a different question from
  which person clicked.
- A peer's prompt bubble stays right-aligned like the owner's — see
  [transcript-rendering](transcript-rendering.md#peer-attribution) — because agent output is
  already flush-left by convention; authorship is carried by avatar/colour, not by side.
- `personMeta`'s palette is deliberately disjoint from `agentMeta`'s, so a human can never be
  mistaken for an agent at a glance.

## Related decisions

- [hosted-machine-access](hosted-machine-access.md) — the `/client` gate this feature makes
  membership-based instead of ownership-only, and the device-verify machinery the grant oracle
  sits beside.
- [multi-machine-client](multi-machine-client.md) — holding a shared machine's link, and the
  session-row/composer visual differentiation for a session that is not on the primary machine.
- [transcript-rendering](transcript-rendering.md) — the bubble convention attribution builds on.
- [permissions-and-plan-mode](permissions-and-plan-mode.md) — `resolvedActor` alongside
  `resolvedBy`.
- [cloud-sync-sessions](cloud-sync-sessions.md) — why a guest connection must never sync.
- [turn-interjection](turn-interjection.md) — releasing a queued item into the turn already
  running, built on this feature's queue, `MESSAGE_AUTHZ`, and attribution.
- [cross-provider-model-switching](cross-provider-model-switching.md) — `switchProvider`'s
  `MESSAGE_AUTHZ` row and the second authz check the table cannot express.
