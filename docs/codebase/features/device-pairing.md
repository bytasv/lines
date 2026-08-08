# Device pairing

## Purpose

Binds a machine (a bridge, running under a tray app or Tilt) to a Clerk user, so
the relay knows which browser connections may reach it. Pairing exists because
the relay must refuse two things by default: an unclaimed machine reachable by
anyone, and a claimed machine reachable by the wrong user.

Only a hash of the machine's pairing secret ever reaches Postgres. The plaintext
is generated on the machine and never leaves it, so a database compromise cannot
yield anything that can impersonate a device — the same argument that lets a
password hash live in a database.

## Entry points

- `storage/src/index.ts` — `POST /v1/devices/register`, `POST /v1/devices/claim`,
  `GET /v1/devices`, `DELETE /v1/devices/:id`, `POST /v1/devices/verify`
- `relay/src/index.ts` — `verifyDevice`, the `/client` ownership gate

## Important files

- `storage/prisma/schema.prisma` — the `Device` model
- `storage/src/index.ts` — the five routes above
- `relay/src/index.ts` — calls `verify`, sets `hub.ownerId`
- `relay/src/mux.ts` — `DeviceHub.ownerId`

## Important symbols

- `Device` — `id`, `userId` (null until claimed), `name`, `platform`,
  `secretHash`, `pairingCode`, `pairingExpiresAt`, `appProtocol`, `revokedAt`
- `DeviceHub.ownerId` — the userId learned when a bridge last authenticated on
  this device; `null` until a bridge has ever attached

## Data flow

1. The machine generates a random secret, keeps it, and calls `register` with
   only its sha256 hash. Storage creates (or re-issues a code for) the `Device`
   row and returns a short human-typeable `pairingCode`.
2. The signed-in user types that code into the web app, which calls `claim`.
   Storage looks the code up, checks it is unexpired and unrevoked, and sets
   `userId` — the step that actually binds machine to account. The code is
   cleared on use so it cannot be replayed.
3. The bridge dials the relay's `/agent` with its id and the plaintext secret.
   The relay calls storage's `verify`, which recomputes the hash and returns the
   owning `userId` on a match. The relay records it as `hub.ownerId`.
4. A browser connecting to `/client?device=…` is refused unless its verified
   Clerk `userId` equals `hub.ownerId`.

## Dependencies

The relay depends on storage for verification (see the note in `remote-relay-bridge.md`
about why the relay holds no database credentials itself). See
[remote-relay-bridge](remote-relay-bridge.md) for the channel this gates, and
[browser-bridge-link](browser-bridge-link.md) for what a channel becomes once
admitted.

## Tests

- `storage/src/schema.credentials.test.ts` — `Device.secretHash` is the one
  allowlisted field, with its justification
- `relay/src/mux.test.ts` — `ownerId` recording; cross-user channel isolation on
  one device

## Business rules

- `register` is unauthenticated: the machine has no user yet, and a code is
  worthless until claimed. Re-registering an already-claimed device is refused
  (409) rather than silently re-bound.
- `claim`, `verify` and expired/revoked lookups all answer the same
  "unknown or expired code" for absent, expired, and revoked — a distinct
  "expired" reply would confirm a guessed code had once been real.
- Revoking a device tombstones it (`revokedAt`) rather than deleting the row, so
  it stays an audit trail.
- `GET /v1/devices` never returns `secretHash`.
- If storage is unreachable, the relay refuses the device rather than admitting
  it — an outage must never widen access.

## Architectural rules

- Only the secret's hash is stored, never the plaintext; see the Purpose section
  for why that boundary matters.
- The relay holds no database credentials and never queries Postgres directly —
  it asks storage, which is the only process with DB credentials at all.
- The cross-user check (`hub.ownerId === userId`) lives on the `/client` gate,
  not deeper in routing, so it fails closed at the earliest point.

## Related decisions

- [remote-relay-bridge](remote-relay-bridge.md) — the channel this pairing gates
- [app-managed-login-only](app-managed-login-only.md) — the other credential
  boundary in the system (Claude OAuth), kept local by the same kind of argument
