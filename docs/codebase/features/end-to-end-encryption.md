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

Both are closed here: the channel is authenticated against keys the machine pinned itself (a
guest's against the machine key in their invite link, then admitted on a grant the machine
minted), and content is signed by the machine that wrote it. Both are **on by default** — there
is no plaintext relay path, owner or guest, and no opt-in.

What this deliberately does **not** claim is in [Residual risks](#residual-risks). The headline:
the code holding the keys is served by the deployment it distrusts, and browser-delivered
cryptography cannot close that.

## Entry points

- Settings → **Encryption** (`web/src/components/EncryptionSection.tsx`) — see whether the
  current link is encrypted, and enrol another key
- The connect-time gate (`ConnectingMachine.tsx` → `EnrollGate`) — where every owner browser but
  the desktop app's own window enrols first, since a machine refuses every relayed owner browser
  until it does; the reason it exists at all. A guest never enrols: their invite link carries the
  machine key and the grant
- Tray → **Show encryption code…**, and the enrolled-browser rows beneath it
  (`desktop/src/main.ts`)
- `npm run enroll -w server` — the same actions without Electron: mint a code, `--list`,
  `--revoke <fingerprint>`
- Settings → **Sync** → Signing (`web/src/components/SyncSection.tsx`) — this machine's
  sync-signing fingerprint, and the other machines this account trusts, each removable
- The **Unverified** / **Not reviewed** badge and **Review** banner on a synced workflow, step or
  recipe this machine holds back (`web/src/components/workflow/UntrustedReview.tsx`) — read what
  it runs, allow it here, or trust the machine that signed it

## Files

- `shared/e2ee.ts` — the whole protocol: identities, handshake, record layer, enrollment proofs
- `server/src/e2eeIdentity.ts` — this machine's static key, the enrolled-peer list, the one-time
  enrollment code; all three 0600 under `~/.lines-app`, none ever uploaded
- `server/src/e2eeChannel.ts` — the gate in front of `handleConnection`; `SecureChannel`,
  `guardRelayChannel`; an owner channel checked against the enrolled list, a guest's against a
  grant (`ChannelPolicy.redeemGuest`)
- `server/src/guestGrants.ts` — the grants this machine mints for invites, which a guest channel
  redeems (`redeemGuestGrant`); minting, revoking and reconciling them is
  [session-collaboration](session-collaboration.md)'s
- `server/src/syncSignature.ts` — blob signing/verification, canonicalisation, signer pinning;
  per-item signing (`signItems`/`verifyItem`), marks (`settledHold`, `markAfterSave`,
  `runnableDigest`), the per-account `ItemTrust` record, `syncKeyFingerprint`
- `server/src/sync.ts` — `SIGNED_PATHS`, signing on push and `checkSignature` on pull; for
  workflows, steps and recipes `checkItems` on pull and `signForPush` on push
- `server/src/workflowCommands.ts` — `trustSyncedItem`, `trustSigner`/`untrustSigner`,
  `syncSigningInfo` (the owner `hello`'s `syncSigning` field)
- `server/src/workflows.ts`, `server/src/recipes.ts`, `server/src/recipeCommands.ts` — where a
  mark is settled and enforced; see [workflow-step-versioning](workflow-step-versioning.md) and
  [recipes](recipes.md)
- `server/src/index.ts` — the relay `onChannel` path, and `handleConnection`'s `peerKey` and
  guest-grant gates
- `server/scripts/enroll-code.ts` — the CLI half of the tray actions
- `web/src/lib/e2ee.ts` — the browser's identity (IndexedDB, non-extractable) and pinned keys;
  a guest's invite grants (`takeJoinGrantFromUrl`, `adoptJoinGrant` — which pins the machine key
  the invite link carries — and `guestGrantTokens`)
- `web/src/ws.ts` — `beginHandshake`, `writeToLink`, `handleE2eeFrame`, `enrollWithCode`,
  `reconnectMachine`, `needsEnrollment`; `MachineLink.pinned`, and the `guestGrant` frame
- `web/src/lib/plaintextFrames.ts` — `plaintextFrameAllowed`: which frames arriving in the clear
  a link may apply
- `web/src/components/SyncSection.tsx` — the Signing group (`SigningGroup`)
- `web/src/components/workflow/UntrustedReview.tsx` — `UntrustedBadge`, `UntrustedReviewModal`
- `desktop/src/main.ts` — `openEncryptionWindow` (code + QR), `revokeEnrolledPeer`,
  `appUrlForOwnWindow`
- `storage/src/index.ts` — `carriedSignature`, which carries a signature across the rebuild the
  blob endpoints perform. Item rows are stored as sent: a version storage will not keep (a recipe
  with off-bucket images) is skipped, never edited, since an edited blob would stop verifying for
  everyone

## Symbols

- `startHandshake` / `acceptHandshake` — the two halves; the bridge's takes an `isEnrolled`
  predicate and refuses an unknown key before deriving anything from it
- `SecureSession.seal` / `.open` — the record layer, with per-direction counters
- `enrollProof` — HMAC under the one-time code; two labels, deliberately asymmetric
- `guardRelayChannel` — wraps a relay channel, hands it to the bridge only when it may carry
  traffic: an owner's after the handshake against a pinned key, a guest's (`guest` set — the
  relay's word that it is one, and who) after its sealed grant redeems (`admitGuest`)
- `plaintextFrameAllowed(pinned, type)` — on a link that opened with a pinned key, only the
  relay's own `deviceOffline`/`deviceOnline` may arrive in the clear; anything else is the relay
  talking and is dropped
- `signBlob` / `verifyBlob` / `canonicalize` — signed sync for blobs
- `signItems` / `verifyItem` — one signature per workflow, step or recipe, over
  `{account, item, kind}`; `verifyItem` checks the crypto only — no pin, no counter
- `UntrustedMark` (`shared/types.ts`) — why this machine will not run a synced item yet:
  `unsigned`, `forged`, `unknown-signer` (another machine's signature) or `foreign` (another
  user's, not reviewed here); `digest` of what it runs; `held: false` when the mark only records
  provenance
- `settledHold` — decides `held` now, from the current strictness and the account's trusted
  keys, and recomputes `signerFingerprint` from the key; `markAfterSave` — the mark an item keeps
  across a local save; `runnableDigest` — SHA-256 of what an item *runs* (a workflow's steps, a
  step's content fields, a recipe's title, prompt and members), so a rename or publish toggle
  neither needs nor voids a review
- `ItemTrust` — per account, `sync-trust.json` (0600, never uploaded): reviewed digests keyed
  `kind:ownerId/id[/version]`, and the machine keys the account trusts
- `syncKeyFingerprint` — the first 8 bytes of SHA-256 over the raw key as `xxxx-xxxx-xxxx-xxxx`,
  the same rendering `fingerprint` gives an enrolled browser's key
- `trustSyncedItem` / `trustSigner` / `untrustSigner` (`workflowCommands.ts`) — approve one
  reviewed digest; trust or revoke a machine key
- `cryptoUnavailable` — why this browser cannot hold a key at all (insecure origin, usually)
- `takeEnrollCodeFromUrl` — reads a code the machine handed this page, from the URL **fragment**,
  and strips it (`dropEnrollParamFromUrl` is the shared strip). The query form is still read because an older desktop build's QR used it, but a
  query string reaches the server, which is the one party the code exists to exclude
- `ProjectTabs` opens Settings > Encryption for an `enroll` fragment/query only while the current
  machine is unpinned; for an already-enrolled browser (e.g. the desktop's own window, which
  always carries a code) the stale param is dropped from the URL and the app lands on the index
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
empty plaintext; only after the client's confirmation opens does the bridge hand an owner
channel to `handleConnection`. There is one handshake per channel: a second `e2eeHello`, or an
`e2eeEnroll`, once one has begun ends it.

**Guest channel.** The invite link's fragment carries the machine's public key, its device id
and a grant token the machine minted for that invite (see
[session-collaboration](session-collaboration.md)); the invitee's browser pins that key
(`adoptJoinGrant`) and handshakes exactly as an owner's does. On a channel the relay labels a
guest's the bridge accepts *any* client key — a guest's is never enrolled — so the handshake
proves only that nobody sits in the middle; what admits the guest is the next frame. The first
sealed frame must be `{type: 'guestGrant', tokens}`: each token is redeemed against what this
machine minted for the user the relay names, one that no longer redeems is skipped, and with
none left — or any other frame first — the channel ends before the bridge ever sees it. The
browser writes the grant the moment `e2eeConfirm` is out, not on `e2eeReady`: sealed writes leave
as soon as the session exists, so anything written in between would overtake it.
`handleConnection` then serves the guest that grant, narrowed by the relay's attestation.

**Records.** Every app message is AES-256-GCM sealed, base64'd, and wrapped as `e2eeData`. The
nonce is a per-direction counter; a receiver refuses a counter it has already passed, so a
replayed or reordered frame ends the channel rather than being skipped. The bridge opens inbound
frames one at a time, in arrival order: opening is asynchronous, and two in flight could finish
out of order — a guest's `ping` overtaking its grant, or an owner's two prompts reordering past
the counter check.

**Browser side.** A link that opened with a pinned machine key (`MachineLink.pinned`, never
cleared for that socket's life) neither sends nor applies a plaintext app frame: writes wait in
the outbox until the session exists, and an incoming plaintext frame other than the relay's own
`deviceOffline`/`deviceOnline` is dropped (`plaintextFrameAllowed`). An `e2eeReady` that arrives
before this link's own handshake finished closes the socket — it travels in the clear and proves
nothing on its own, so one that early was written in the middle to talk the link out of
encrypting.

**Signed sync.** On push, the bridge signs the blob (ECDSA P-256 over canonical JSON plus a
monotonic counter) and the signature rides inside the `data` column the table already has. On
pull, the signer is checked against a pinned key and the counter against the last one seen.

**Signed library items.** Workflows, steps and recipes each carry their own signature under the
same reserved key, over `{account, item, kind}` — `createdAt` (storage injects it from its own
column) and the bridge's mark left out. On pull, `checkItems` verifies every item: this machine's
own signature arrives clean; anything else — unsigned, forged, another machine's — arrives with
an `UntrustedMark` and is kept and shown, never dropped. The engines then settle it: an approval
of that exact digest in `ItemTrust`, or an identical trusted copy already held, clears it, and
another machine's signature stops holding the item back only if the account trusts that machine.
Another user's workflow or step is marked `foreign` on owner alone unless already reviewed; their
recipes are confirmed per run instead (see [recipes](recipes.md)). On push, `signForPush` signs
only unmarked rows, re-sending a row's previous signature while its payload is unchanged; an
unsigned or forged row travels unsigned, and another machine's or another user's row is not
pushed at all.

## Tests

- `server/src/e2ee.test.ts` — handshake success; unknown key refused; substituted bridge key
  fails confirmation; a copied public key cannot confirm; replay, reorder, truncated tag, and
  re-labelled counter all refused; enrollment proof binds both keys
- `server/src/e2eeChannel.test.ts` — the adversarial relay: forged `open` with no key, unknown
  key, key substitution, a replay that must end the channel, an unenrolled machine refusing a
  plaintext owner frame with 1008; and the guest gate — never handed over on the relay's word,
  any client key handshakes but a sealed grant must follow, a token this machine did not mint
  (or minted for someone else) or any other sealed frame first ends the channel, a guest cannot
  enrol, a revoked token is skipped while another still redeems, frames after the grant arrive in
  order, and a second handshake cannot take over an admitted channel
- `server/src/plaintextFrames.test.ts` — `plaintextFrameAllowed` (the browser's half, run from
  the server's runner, the only one in the repo): no plaintext app frame applies on a pinned link
  whatever the handshake state, the relay's two control frames still do, an unpinned link takes
  plaintext
- `server/src/syncSignature.test.ts` — canonicalisation is order-independent; unsigned, forged,
  signer-changed and rolled-back blobs each refused with their own verdict; items verify after
  storage injects `createdAt`, a signature is bound to its account and kind (a row cannot be
  moved), a batch reserves its counters in one store write, the runnable digest ignores names and
  key order; which reasons hold under strict and `LINES_E2EE_STRICT=0`; a save keeps a mark and a
  client cannot clear one; `ItemTrust` is per account; fingerprints render as an enrolled
  browser's do; trusting and revoking a machine key
- `server/src/sync.items.test.ts` — every pulled item is checked and only this machine's
  signature arrives unmarked; `LINES_E2EE_STRICT=0` runs unsigned and forged items but keeps
  them marked; a push signs only what this machine vouches for and never launders a marked row
- `server/src/workflows.trust.test.ts` — the engine side: what holds an item back, the digest a
  review must echo, approvals that release content only, `trustSigner` refusing a fingerprint
  that is not the key's, and a revoke holding back again, also after a restart
- `server/src/relayEndToEnd.test.ts` — the honest-relay path works end to end with a real
  enrolment and handshake in the fixture, and a browser with no key is refused; this is what
  caught the guest-handover deadlock described below
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
  local sockets are unaffected.
- A relayed **guest** channel is end-to-end encrypted too, against the machine key its invite
  link carries, and is admitted only on a grant this machine minted, presented as the first
  sealed frame — never on the relay's word. That word now only picks which check applies: a
  guest the relay labels an owner holds no key this machine enrolled, and an owner it labels a
  guest holds no grant.
  A guest channel cannot enrol a device, whatever code it holds; enrolling adds an owner device.
- What a guest may do is the grant this machine issued, narrowed by the relay's attestation (a
  share revoked or narrowed in storage narrows here too). The relay can take access away; it can
  no longer give it. A guest client older than `APP_PROTOCOL_VERSION` 6 sends plaintext and is
  refused, and the relay does not put a guest through to a bridge older than 6
  (`RELAY_COLLAB_MIN_PROTOCOL`), which would still admit one on the relay's word.
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
- Signed sync covers the blobs `/settings`, `/guard-allowlist` and `/mcp-connections`, whose
  envelope storage keeps intact, and every workflow, step and recipe **per item** — each of those
  rows keeps its own JSON whole in a `data` column, and their prompts are what runs. `/memory` and
  `/project-keys` are maps merged per key in SQL and sessions are an array; none of those carries
  a signature yet. They rely on the review gate in front of pulled memory and on `adoptSynced`'s
  field stripping and workflow marking instead (see [cloud-sync-sessions](cloud-sync-sessions.md)).
- Blob sync is strict by default: an unsigned blob is refused, as are forged, signer-changed and
  rolled-back ones. `LINES_E2EE_STRICT=0` accepts unsigned blobs with a warning and is for
  recovery only (say, a fleet with a bridge too old to sign). A refusal is logged and treated as
  an empty cloud row, so the same sync pass pushes this machine's copy signed and overwrites it.
  A mixed fleet is the cost: a bridge that never signs has its blobs refused by upgraded ones.
- Blob signing keys are trust-on-first-use, then pinned. A *changed* signer is refused and
  surfaced, the way SSH treats a changed host key. The weakness is the first blob — a database
  compromised before this machine ever pulled from it can seed its own key.
- A library item this machine did not sign is **kept and shown, never dropped**, and held back
  from running until reviewed — refused by every path that would run it. Under
  `LINES_E2EE_STRICT=0` an `unsigned` or `forged` item still runs but keeps its mark, so this
  machine never re-signs it as its own; another machine's or another user's item is held back
  either way.
- Items get no trust-on-first-use: only this machine's own key is trusted. Pinning one signer per
  resource, as the blobs do, would refuse every edit made on the user's second machine as a
  changed signer. Another machine is trusted only by an explicit `trustSigner`, after the user
  compares its fingerprint with the one that machine shows in its own Settings → Sync; the bridge
  refuses a fingerprint that is not that key's. Everything that machine signed, and signs later,
  then runs here. Revoking holds back again — at once, and on every later load — whatever only it
  vouched for. The cost: until then, every edit made on another of the user's machines is held
  back here for review.
- Approving a held-back item (`trustSyncedItem`) approves its reviewed digest and nothing more —
  not the machine that signed it, not a later change, not a second copy of the same version
  holding different content. A stale digest is refused, so content that changed under the review
  is not what becomes runnable. Revoking a machine leaves item approvals standing: those were
  decisions about content.
- Neither an edit nor a copy clears a mark: an edited held-back item stays held back, and a copy
  (Duplicate, Make an editable copy) carries its original's mark. An edit made here to a trusted
  machine's item becomes this machine's own and is signed by it.
- A mark is this bridge's own verdict. It is never pushed, it is stripped from every pulled row,
  a client message may only *add* one (a copy saying what it copied), and it is re-decided
  (`settledHold`) on every load and pull — so a decision made under `LINES_E2EE_STRICT=0`, or
  before a key was revoked, cannot outlive it.
- This machine's sync-signing fingerprint and its account's trusted machines are owner-only
  (`hello.syncSigning`); a guest's view has neither. The key is minted the first time the machine
  signs or checks a synced item, after the `hello` that would have shown it, so that sync pass
  announces it once with a `syncSigning` broadcast.

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
- No channel is handed over **in the constructor** any more; every relay channel authenticates
  first. A plaintext guest once had to be: the bridge speaks first — `handleConnection` sends
  `hello` on open — and a keyless guest browser waited for it, so deferring its handover until its
  first frame deadlocked every relayed guest connection (`relayEndToEnd.test.ts` caught exactly
  this). A guest's browser now holds the machine key from its invite link and opens with
  `e2eeHello`, as an owner's does, so that deadlock cannot arise.
- On both kinds of channel, then, the browser speaks first. The bridge attaches its handler only
  after loading its key asynchronously, so `RelayChannel` and `SecureChannel` hold frames that
  arrive before anyone listens rather than dropping them — a dropped `e2eeHello` or `e2eeEnroll`
  leaves the browser waiting forever.
- One handshake per channel, and no enrolment once one has begun. A guest channel takes any
  client key, so a second `e2eeHello` under a channel the bridge already holds would be the relay
  swapping itself in as the admitted guest — the guest's grant, none of their keys. It is refused
  (1008) like any other attempt to author traffic.
- `SecureChannel` serializes inbound frames through one promise chain rather than opening them
  concurrently: the grant has to stay first on a guest channel, and the counter check is only
  meaningful in arrival order.
- `handleConnection` re-checks what the gate decided: a guest connection with no grants, or with
  grants for a host other than the one the relay names, is closed 1008. It is the second lock on
  the guest door, as `peerKey` is on the owner's, and the host whose context a guest reaches is
  named by the grant, not by the relay.
- A guest refusal never contains the phrase "end-to-end encrypted channel": the client keys its
  owner `EnrollGate` on it, and a guest has nothing to enrol — they need the invite link again.
- `MachineLink.pinned` is set from whether the socket opened with a pinned key and is never
  cleared, unlike `expectsSecure`: keying on handshake progress is what let a forged plaintext
  `e2eeReady` talk a link back into plaintext. `plaintextFrameAllowed` is a pure function in
  `web/src/lib` so the server's test runner can cover it.
- The account is bound into every item signature because one machine key signs for every account
  on that machine and some items (the seeded default workflow, older rows) carry no `ownerId`; an
  item's `ownerId` is signed as well. `createdAt` is left out because storage injects it from its
  own column on `GET /workflows` and `/steps`.
- `signForPush` never signs a marked row: that would launder content this machine never vouched
  for into a row every peer runs as this machine's own. A batch reserves its counters in one
  store write (`reserveCounters`), and an unchanged row re-sends its cached signature rather than
  being re-signed and re-counted on every push of its list.
- `ItemTrust` is read on every call rather than cached, because both engines and the command
  layer hold one each and must agree. It is per account, 0600 beside that user's state, and never
  uploaded — a trust decision storage could write is one an attacker with the database could
  write. Fingerprints are computed on the bridge, which holds the keys, and handed to the browser
  ready-made; a mark's `signerFingerprint` is never taken from disk or the wire.
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
  compromise" to "host or reverse-proxy compromise" — a real reduction, not a solution. The apex
  (the relay's host) serves only a keyless static marketing page, never the app bundle. Keys and
  pins are per origin, so moving the app host (`app.` to `run.`) makes every browser enrol again. The
  desktop app would close it for laptops; only a native app would close it on a phone.
- **Guests.** Admission and the capability ceiling are host-issued: a grant this machine minted,
  redeemed inside a channel the relay cannot sit in, which the relay can narrow but never widen.
  What stays relay-attested is the guest's *account* identity — who the token was presented as,
  which is what attribution, presence and binding a grant to its first redeemer rest on — and the
  connection metadata. The token proves possession of the invite link, not which account signed
  in, and it is a bearer secret: whoever holds the link first holds the grant.
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
- [session-collaboration](session-collaboration.md) — the guest grants a guest channel is
  admitted on
- [workflow-step-versioning](workflow-step-versioning.md) — where held-back workflows and steps
  are reviewed
- [recipes](recipes.md) — held-back own recipes, and why another user's recipe is confirmed per
  run instead of marked
