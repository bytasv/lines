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
content is signed by the machine that wrote it.

What this deliberately does **not** claim is in [Residual risks](#residual-risks). The headline:
the code holding the keys is served by the deployment it distrusts, and browser-delivered
cryptography cannot close that.

## Entry points

- Settings → **Encryption** (`web/src/components/EncryptionSection.tsx`) — enrol this browser,
  see whether the current link is encrypted
- The connect-time gate (`ConnectingMachine.tsx` → `EnrollGate`) — the *only* way to enrol a
  browser that a machine is already refusing, and the reason it exists at all
- Tray → **Show encryption code…**, and the enrolled-browser rows beneath it
  (`desktop/src/main.ts`)
- `npm run enroll -w server` — the same actions without Electron: mint a code, `--list`,
  `--revoke <fingerprint>`

## Files

- `shared/e2ee.ts` — the whole protocol: identities, handshake, record layer, enrollment proofs
- `server/src/e2eeIdentity.ts` — this machine's static key, the enrolled-peer list, the one-time
  enrollment code; all three 0600 under `~/.lines-app`, none ever uploaded
- `server/src/e2eeChannel.ts` — the gate in front of `handleConnection`; `SecureChannel`,
  `guardRelayChannel`, `e2eeRequired`
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
- `e2eeRequired` — whether this machine refuses an unauthenticated owner channel
- `guardRelayChannel` — wraps a relay channel, hands it to the bridge only when it may carry
  traffic
- `signBlob` / `verifyBlob` / `canonicalize` — signed sync
- `cryptoUnavailable` — why this browser cannot hold a key at all (insecure origin, usually)
- `takeEnrollCodeFromUrl` — reads a code the machine handed this page, from the URL **fragment**,
  and strips it. The query form is still read because an older desktop build's QR used it, but a
  query string reaches the server, which is the one party the code exists to exclude
- `appUrlForOwnWindow()` — the URL the desktop shell opens its own window with, carrying a live
  code in the fragment. A machine's own window enrolling by hand-typed code was a step with no
  security value: the shell and the bridge are already the same trust domain
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
  key, key substitution, a replay that must end the channel, and the unenrolled machine still
  working in the clear
- `server/src/syncSignature.test.ts` — canonicalisation is order-independent; unsigned, forged,
  signer-changed and rolled-back blobs each refused with their own verdict
- `server/src/relayEndToEnd.test.ts` — the honest-relay path still works end to end, which is
  what caught the deadlock described below

## Business rules

- A machine requires an authenticated channel **only once a device is enrolled**
  (`e2eeRequired`). Shipping any other way would have locked every existing install out of its
  own bridge on upgrade. Enrolling one browser is the step that turns the protection on.
- That requirement is machine-wide, not per-device. Per-device would be no protection at all: an
  attacker simply declines to enrol and takes the unencrypted path. The cost is real and is
  stated in the UI — after enrolling one browser, every other browser you own must enrol too.
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
- An unsigned blob is accepted with a warning during rollout; a forged, signer-changed or
  rolled-back blob is always refused. `LINES_E2EE_STRICT=1` promotes the first case to a refusal
  too.
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
- On a machine that requires no key, the channel is handed over **in the constructor**. The
  bridge speaks first — `handleConnection` sends `hello` on open and the browser waits for it —
  so deferring the handover until the first client frame deadlocks every relayed connection.
  `relayEndToEnd.test.ts` caught exactly this.
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
- **Strict mode has never run against a live client.** Do not default it on before the tray-side
  re-enrolment path has been tested end to end.

## Related decisions

- [hosted-machine-access](hosted-machine-access.md)
- [production-deployment](production-deployment.md)
- [agent-memory-sync](agent-memory-sync.md)
- [cloud-sync-sessions](cloud-sync-sessions.md)
- [session-collaboration](session-collaboration.md)
