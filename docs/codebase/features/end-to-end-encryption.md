# End-to-end encryption

## Purpose

Make the hosted server untrusted: it brokers connections and stores blobs, and it must never be
able to read a session's traffic or — far more important — cause the agent to execute anything.

Two doors were open, and they are independent.

**The relay was the auth edge.** `handleConnection` took an `attested` identity supplied only by
the relay path and used it verbatim: no verification, owner access granted on the relay's word.
A compromised relay could forge an `open` frame naming any user, then send `prompt` frames with
full owner authority. The bridge had no way to contradict it, because nothing the browser signed
ever reached the bridge.

**The database was applied to disk.** Pulled rows were type-asserted rather than validated, and
agent memory was written straight into `~/.claude` — which is read into the prompt of *every*
session on the machine. Anyone who could write those Postgres rows, or who obtained the Clerk
token the bridge forwards to storage, had prompt injection with a persistence guarantee.

Both are closed here: the channel is authenticated against keys the machine pinned itself, and
content is signed by the machine that wrote it. Both are **on by default** — there is no
plaintext owner path and no opt-in.

What this deliberately does **not** claim is in [Residual risks](#residual-risks). The headline:
the code holding the keys is served by the deployment it distrusts, and browser-delivered
cryptography cannot close that.

## Entry points

- Settings → **Encryption** (`web/src/components/EncryptionSection.tsx`) — see whether the
  current link is encrypted, and enrol another key
- The connect-time gate (`ConnectingMachine.tsx` → `EnrollGate`) — where every browser but the
  desktop app's own window enrols first, since a machine refuses all relayed browsers until they
  do; the reason it exists at all
- Tray → **Show encryption code…**, and the enrolled-browser rows beneath it
  (`desktop/src/main.ts`)
- `npm run enroll -w server` — the same actions without Electron: mint a code, `--list`,
  `--revoke <fingerprint>`

## Files

- `shared/e2ee.ts` — the whole protocol: identities, handshake, record layer, enrollment proofs
- `server/src/e2eeIdentity.ts` — this machine's static key, the enrolled-peer list, the one-time
  enrollment code; all three 0600 under `~/.lines-app`, none ever uploaded
- `server/src/e2eeChannel.ts` — the gate in front of `handleConnection`; `SecureChannel`,
  `guardRelayChannel`
- `server/src/syncSignature.ts` — blob signing/verification, canonicalisation, signer pinning
- `server/src/sync.ts` — `SIGNED_PATHS`, signing on push and `checkSignature` on pull
- `server/src/index.ts` — the relay `onChannel` path, and `handleConnection`'s `peerKey` gate
- `server/scripts/enroll-code.ts` — the CLI half of the tray actions
- `web/src/lib/e2ee.ts` — the browser's identity (IndexedDB, non-extractable) and pinned keys
- `web/src/ws.ts` — `beginHandshake`, `writeToLink`, `handleE2eeFrame`, `enrollWithCode`,
  `reconnectMachine`, `needsEnrollment`
- `desktop/src/main.ts` — `openEncryptionWindow` (code + QR), `revokeEnrolledPeer`,
  `appUrlForOwnWindow`
- `storage/src/index.ts` — `carriedSignature`, which carries a signature across the rebuild the
  blob endpoints perform

## Symbols

- `startHandshake` / `acceptHandshake` — the two halves; the bridge's takes an `isEnrolled`
  predicate and refuses an unknown key before deriving anything from it
- `SecureSession.seal` / `.open` — the record layer, with per-direction counters
- `enrollProof` — HMAC under the one-time code; two labels, deliberately asymmetric
- `guardRelayChannel` — wraps a relay channel, hands it to the bridge only when it may carry
  traffic
- `signBlob` / `verifyBlob` / `canonicalize` — signed sync
- `cryptoUnavailable` — why this browser cannot hold a key at all (insecure origin, usually)
- `takeEnrollCodeFromUrl` — reads a code the machine handed this page, from the URL **fragment**,
  and strips it. The query form is still read because an older desktop build's QR used it, but a
  query string reaches the server, which is the one party the code exists to exclude
- `appUrlForOwnWindow()` — the URL the desktop shell opens its own window with, carrying a live
  enrollment code in the fragment whenever it runs in relay mode (a machine always needs one). A machine's own window enrolling
  by hand-typed code was a step with no security value: the shell and the bridge are already the
  same trust domain. The same fragment also always carries `host=<deviceId>`, unrelated to
  encryption — see [desktop-app](desktop-app.md#the-desktop-shells-own-window) — which
  `takeHostDeviceIdFromUrl`/`readHostDeviceId` (`web/src/lib/e2ee.ts`) consume and persist so
  `useCanBrowseFolders` can tell this window is sitting at the host
- `reconnectMachine(deviceId)` — re-dial the link that was just enrolled. `reconnectNow()` could
  not serve this: it re-dials the *primary*, which during the connect-time gate is not
  necessarily the machine the user is enrolling against

## Data flow

**Enrollment** (once per browser per machine). The machine mints a 20-character code and shows
it — tray window, QR, or CLI. The browser computes `HMAC(code, "enroll" ‖ clientKey)` and sends
its public key with that proof. The bridge verifies against the live code, pins the key, deletes
the code, and answers with its own public key plus `HMAC(code, "enrolled" ‖ clientKey ‖
bridgeKey)`. The browser checks that second MAC before pinning, which is what stops anything in
the middle from substituting a key. The code itself never travels.

**Handshake** (every connection, once a pin exists). Client sends a fresh ephemeral with its
static key. Bridge looks the static key up in its *local* enrolled list — not in anything the
relay said — generates its own ephemeral, and mixes three Diffie-Hellmans through HKDF with the
transcript as salt: `ee` for forward secrecy, `es` proving the bridge, `se` proving the client.
Both static public keys are inside the transcript, so substituting either derives a different
key and the first confirmation fails to decrypt. Each side sends an AEAD confirmation over an
empty plaintext; only after the client's confirmation opens does the bridge hand the channel to
`handleConnection`.

**Records.** Every app message is AES-256-GCM sealed, base64'd, and wrapped as `e2eeData`. The
nonce is a per-direction counter; a receiver refuses a counter it has already passed, so a
replayed or reordered frame ends the channel rather than being skipped.

**Signed sync.** On push, the bridge signs the blob (ECDSA P-256 over canonical JSON plus a
monotonic counter) and the signature rides inside the `data` column the table already has. On
pull, the signer is checked against a pinned key and the counter against the last one seen.

## Tests

- `server/src/e2ee.test.ts` — handshake success; unknown key refused; substituted bridge key
  fails confirmation; a copied public key cannot confirm; replay, reorder, truncated tag, and
  re-labelled counter all refused; enrollment proof binds both keys
- `server/src/e2eeChannel.test.ts` — the adversarial relay: forged `open` with no key, unknown
  key, key substitution, a replay that must end the channel, an unenrolled machine refusing a
  plaintext owner frame with 1008, and a guest channel still handed over in the constructor
- `server/src/syncSignature.test.ts` — canonicalisation is order-independent; unsigned, forged,
  signer-changed and rolled-back blobs each refused with their own verdict
- `server/src/relayEndToEnd.test.ts` — the honest-relay path works end to end with a real
  enrolment and handshake in the fixture, and a browser with no key is refused; this is what
  caught the deadlock described below
- `server/src/sync.availability.test.ts` — unsigned blob refused by default, accepted under
  `LINES_E2EE_STRICT=0`, forged refused either way

## Business rules

- Every relayed **owner** channel must authenticate, from a machine's first launch, whether or
  not anything is enrolled — there is no plaintext owner path and no escape hatch. Before a
  browser enrols, the only thing such a channel can do is enrol.
- That requirement is machine-wide, not per-device. Per-device would be no protection at all: an
  attacker simply declines to enrol and takes the unencrypted path. Every browser you own
  enrols once, and the UI says so.
- The first browser gets in through the existing bootstrap: the desktop's own window is handed a
  code by the shell and enrols itself; any other browser lands on `EnrollGate` and needs a code
  from the tray ("Show encryption code…") or `npm run enroll -w server`. Direct (non-relay)
  local sockets are unaffected, and guest channels are still plaintext (see residual risks).
- Upgrade note: an existing install with nothing enrolled starts refusing web and phone browsers
  after updating, until the user fetches a code. Desktop windows self-enrol; headless or Docker
  bridges need the CLI. A browser on a plain-http origin has no WebCrypto and cannot connect over
  the relay at all.
- A code is single-use and expires in 15 minutes. Minting a new one invalidates the outstanding
  one.
- 20 characters of a 32-symbol alphabet is 100 bits, which is what makes a *typed* code safe
  against an attacker who can watch the exchange. A short code would need a PAKE (SPAKE2, CPace);
  that needs a vetted library and external review and is deliberately not here.
- The browser's private key is non-extractable and lives in IndexedDB. A later XSS in that origin
  can use it but cannot carry it away.
- No key material is ever uploaded. `storage/prisma/schema.prisma` has no public-key column and
  must not gain one: a key the server can rewrite is a key an attacker with the database can
  rewrite.
- The code travels in a URL **fragment**, never a query string, and is consumed and stripped on
  read.
- `EnrollGate` states the exchange as numbered steps, because step one happens on a *different
  device* from the one the user is looking at. It is also not a dead end: it lists the account's
  other machines and offers pairing a new one, so a user who cannot reach the machine holding the
  code has somewhere to go.
- Revocation is local and needs no browser — tray row, or `npm run enroll -w server -- --revoke`.
  Key pinning plus a lost device would otherwise be unrecoverable.
- Signed sync covers `/settings`, `/guard-allowlist` and `/mcp-connections` — the resources whose
  blob storage keeps intact. `/memory` and `/project-keys` are maps merged per key in SQL, and
  sessions/workflows/steps/recipes are arrays; none can carry an envelope signature without a
  per-row column. Those rely on the review gate in front of pulled memory and on `adoptSynced`'s
  field stripping instead.
- Sync is strict by default: an unsigned blob is refused, as are forged, signer-changed and
  rolled-back ones. `LINES_E2EE_STRICT=0` accepts unsigned blobs with a warning and is for
  recovery only (say, a fleet with a bridge too old to sign). A refusal is logged and treated as
  an empty cloud row, so the same sync pass pushes this machine's copy signed and overwrites it.
  A mixed fleet is the cost: a bridge that never signs has its blobs refused by upgraded ones.
- Machine signing keys are trust-on-first-use, then pinned. A *changed* signer is refused and
  surfaced, the way SSH treats a changed host key. The weakness is the first blob — a database
  compromised before this machine ever pulled from it can seed its own key.

## Architectural rules

- `attested.userId` is a **routing hint**, not an authorization decision. This sentence replaces
  the rule that used to say the opposite in
  [hosted-machine-access](hosted-machine-access.md); if you find the old wording anywhere, it is
  wrong.
- WebCrypto primitives only — ECDH P-256, HKDF-SHA256, AES-256-GCM, ECDSA P-256. Zero
  dependencies in either workspace, and the browser gets non-extractable keys. X25519/Ed25519 is
  nicer crypto but needs a library and loses that property.
- The construction follows Noise IK's shape and is written out longhand so the whole of it is
  auditable in one file. **Do not invent a variant.** If it needs to change, either follow Noise
  IK precisely or get the change externally reviewed.
- The crypto layer wraps a byte channel, not a WebSocket. A WebRTC DataChannel can be slotted
  underneath with no protocol change — that is the whole of the "design for P2P" requirement.
- `guardRelayChannel` sits between `RelayClient` and `handleConnection`, not inside either: the
  bridge's message switch should not grow a crypto branch, and the relay client should stay a
  transport.
- A **guest** channel, which has no key to present, is handed over **in the constructor**; an
  owner channel is handed over only after the handshake. The bridge speaks first —
  `handleConnection` sends `hello` on open and the browser waits for it — so deferring a guest's
  handover until its first frame would deadlock every relayed guest connection.
  `relayEndToEnd.test.ts` caught exactly this.
- The reverse holds on an owner channel: the browser speaks first. The bridge attaches its
  handler only after loading its key asynchronously, so `RelayChannel` and `SecureChannel` hold
  frames that arrive before anyone listens rather than dropping them — a dropped `e2eeHello` or
  `e2eeEnroll` leaves the browser waiting forever.
- An encrypted session cannot outlive the bridge socket it was made on, so the relay closes owner
  channels (1012) whenever a bridge attaches rather than replaying them; the browser redials and
  handshakes again.
- A client that a machine has refused reconnects **silently**: no heartbeat, no auth relay. The
  bridge refuses the first plaintext app frame, and the heartbeat is one a second in, so without
  this there is no window in which to enrol.
- `reconnectMachine(deviceId)` re-dials a link by name. Enrollment must not use
  `reconnectNow()`, which acts on the primary — on the connect-time gate the primary is a
  different machine, or unset, and the enrolled link is left on its old keyless socket.
- Structural stand-ins (`CryptoKeyLike`, `SubtleLike`) exist because the bridge's tsconfig has no
  DOM lib and `@types/node` keeps WebCrypto inside `node:crypto`. One implementation, two
  toolchains.
- Base64 inflates payloads ~33%, so the broadcast backpressure thresholds in `userContext.ts`
  were raised by a third. `isDroppable` still inspects `msg.type` before serialization, so stream
  shedding is unaffected.
- The enrollment surfaces check `cryptoUnavailable()` before accepting input. An insecure origin
  has no WebCrypto at all, and the fix is a different URL — not a retry.

## Residual risks

Stated plainly, because a claim of "untrusted server" that ignores these is worse than no claim.

- **The web origin.** The bundle is served by the same deployment it distrusts. Anyone who can
  serve modified JavaScript from that origin owns the code holding the keys. Origin separation
  (see [production-deployment](production-deployment.md)) narrows this from "any server-side
  compromise" to "host or reverse-proxy compromise" — a real reduction, not a solution. The
  desktop app would close it for laptops; only a native app would close it on a phone.
- **Guests.** v1 enrols owner devices only. A guest's identity, caps and attribution remain
  relay-forgeable. Closing it needs owner-device-mediated key distribution and a revocation
  story.
- **Data at rest.** Signatures give integrity, not confidentiality. Postgres still holds session
  metadata, workflows and agent memory in plaintext.
- **Availability.** A compromised relay can always drop or delay traffic. Integrity is
  defensible; uptime is not.
- **Metadata.** The relay still sees which device, when, and how much.
- **Strict sync is now the default but has not run against a live account.** It is covered by
  unit tests only. Rows written before signing existed are refused until the first re-push
  overwrites them, so verify against a real account before release; until then a mixed fleet
  loses sync between signing and non-signing bridges.

## Related decisions

- [hosted-machine-access](hosted-machine-access.md)
- [production-deployment](production-deployment.md)
- [agent-memory-sync](agent-memory-sync.md)
- [cloud-sync-sessions](cloud-sync-sessions.md)
- [session-collaboration](session-collaboration.md)
