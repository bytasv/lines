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
- `server/src/device.ts` — `deviceIdentity`, `registerDevice`; shared by the
  desktop app and `npm run pair -w server`
- `server/scripts/pair-device.ts` — CLI/Tilt entry point that calls the above
  and prints the pairing code

## Important files

- `storage/prisma/schema.prisma` — the `Device` model
- `storage/src/index.ts` — the five routes above, plus CORS and the
  unauthenticated-path allowlist that fronts them
- `relay/src/index.ts` — calls `verify`, sets `hub.ownerId`
- `relay/src/mux.ts` — `DeviceHub.ownerId`
- `server/src/device.ts` — identity minting/registration, shared to avoid a
  second implementation drifting on the credential format
- `Tiltfile` — the `pair-device` resource

## Important symbols

- `Device` — `id`, `userId` (null until claimed), `name`, `platform`,
  `secretHash`, `pairingCode`, `pairingExpiresAt`, `appProtocol`, `revokedAt`
- `DeviceHub.ownerId` — the userId learned when a bridge last authenticated on
  this device; `null` until a bridge has ever attached
- `deviceIdentity()` — loads `~/.lines-app/device.json` or mints one; a corrupt
  file is treated as a new machine rather than a fatal error

## Data flow

1. The machine generates a random secret, keeps it, and calls `register` with
   only its sha256 hash. Storage creates (or re-issues a code for) the `Device`
   row and returns a short human-typeable `pairingCode`.
2. The signed-in user types that code into the web app, which calls `claim`.
   Storage looks the code up, checks it is unexpired and unrevoked, and sets
   `userId` — the step that actually binds machine to account. The code is
   cleared on use so it cannot be replayed.
3. The bridge dials the relay's `/agent` with its id and the plaintext secret.
   The relay calls storage's `verify` (authenticated by a shared secret, not a
   user token — see below), which recomputes the hash and returns the owning
   `userId` on a match. The relay records it as `hub.ownerId`.
4. A browser connecting to `/client?device=…` is refused unless its verified
   Clerk `userId` equals `hub.ownerId`.

In a hosted deployment the browser calls storage cross-origin (it lives on its
own subdomain — see [production-deployment](production-deployment.md)), so
storage answers CORS preflights against an explicit `WEB_ORIGINS` allowlist
before the auth gate runs; a wildcard origin is not used because these
responses carry Clerk-authenticated user data.

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
  worthless until claimed. Re-registering an already-claimed **and unrevoked**
  device is refused (409) rather than silently re-bound. A **revoked** device is
  the exception: register clears the stale `userId` and `revokedAt` and issues a
  fresh code, or a revoked machine could never be claimed by anyone again —
  `claim` refuses a revoked row, and the relay's `verify` refuses it too, so a
  device stuck in that state would otherwise be permanently dead.
- `claim`, `verify` and expired/revoked lookups all answer the same
  "unknown or expired code" for absent, expired, and revoked — a distinct
  "expired" reply would confirm a guessed code had once been real.
- Revoking a device tombstones it (`revokedAt`) rather than deleting the row, so
  it stays an audit trail. Revoking stops it *reconnecting* — the relay checks
  `revokedAt` on attach, not on every frame — so a connection already open is
  unaffected until it next drops.
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
- `POST /v1/devices/verify` is called machine-to-machine by the relay with no
  Clerk token to present, so it sits behind a constant-time-compared shared
  secret (`RELAY_SHARED_SECRET`) instead of the Clerk gate, and is excluded from
  storage's public router in a hosted deployment (see
  [production-deployment](production-deployment.md)) so it is unreachable from
  the internet even with the secret guessed. Unset, storage refuses verification
  with 503 rather than falling open.
- Device identity (mint, hash, register) lives in `server/src/device.ts` rather
  than duplicated in the desktop app and the CLI pairing script, so the two
  cannot drift on the credential format.

## Related decisions

- [remote-relay-bridge](remote-relay-bridge.md) — the channel this pairing gates
- [app-managed-login-only](app-managed-login-only.md) — the other credential
  boundary in the system (Claude OAuth), kept local by the same kind of argument
