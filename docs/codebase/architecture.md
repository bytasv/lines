# Architecture

The one page to read before the feature docs. Source code is authoritative; this describes the
shape the features assume.

## The bridge/worker split

The agent side of Lines is two Node processes, not one.

- **worker** (`server/src/worker.ts`) holds every live Claude query. Its import graph is
  deliberately minimal — stdlib, `ws`, the agent SDK, and `server/src/workerProtocol.ts` — and it
  does no error interpretation, no persistence, and no policy.
- **bridge** (`server/src/index.ts`) owns everything else: sessions, workflows, permissions,
  transcripts, storage sync, the relay client, and the browser-facing WebSocket.

The worker owns **both** engines' children: the Claude CLI processes, and the long-lived
`codex app-server` a session on an OpenAI model runs its turns through.

They exist as separate processes because a bridge restart must not take a turn with it. During
development the bridge hot-reloads on every edit; the worker does not, so an in-flight query
survives. That is also why the worker forwards codex notifications verbatim and normalizes
nothing — the mapping belongs on the hot-reloadable side. The worker is never auto-restarted on crash either — its queries are already gone, and
a silent respawn would look like a healthy session that lost its turn.

The two speak `server/src/workerProtocol.ts` over a loopback WebSocket, versioned by
`PROTOCOL_VERSION`. Each binds an ephemeral port and publishes it (with a per-boot token) under
`~/.lines-app/run/<instance>/`; nothing hardcodes a port. Keep `worker.ts` thin — logic that
creeps into it is logic that cannot hot-reload.

## The five deployables

| | what it is | where it runs |
|---|---|---|
| `server/` | bridge + worker (the agent) | the user's own machine |
| `web/` | the React client | a browser, served from the hosted origin or Vite in dev |
| `relay/` | a frame router between a browser and a bridge | hosted |
| `storage/` | Postgres-backed sync API (Prisma) + device registry | hosted |
| `desktop/` | Electron menu-bar shell supervising `server/`'s two children | the user's own machine |

`shared/` is not deployed — it is the type and pure-helper layer both sides import
(`shared/types.ts` carries every wire message and most shared predicates).

A browser reaches a bridge one of two ways: directly over loopback (local development, or the
desktop app's local mode), or through the relay. The bridge dials **out** to the relay, so the
user's machine accepts no inbound connection — no port forwarding, no NAT change, no dynamic DNS.
A relayed connection is presented to the bridge as an ordinary `BrowserLink`, so
`handleConnection` cannot tell the two apart.

## Where state lives

- **On the user's machine, under `~/.lines-app/`** — session metadata and transcripts, workflows
  and step versions, the guard allowlist, recent projects, the app's Claude OAuth tokens, the
  device identity, and the runtime port-discovery files. Also per app user:
  `users/<id>/codex/` — the `CODEX_HOME` every codex child runs with, holding the OpenAI
  credentials codex itself owns, and `users/<id>/openai-account.json`, non-secret account
  metadata Lines keeps so the account row can name the account without a network call. This is the working copy: the bridge
  reads and writes it directly and broadcasts changes to every connected browser.
- **In Postgres, via `storage/`** — a per-user mirror pushed by the bridge (sessions, workflows,
  steps and their version history, recipes, settings, agent memory, the guard allowlist) plus the
  device registry. Storage is a sync and multi-machine layer, not the runtime source of truth.
- **In the browser** — view state only, plus two deliberate exceptions kept out of
  `localStorage`'s way: unsent composer drafts (text in `localStorage`, staged attachments in
  IndexedDB) and open-file/tab state.
- **In the relay** — nothing. It persists no state and logs no payload.
- **In `~/.claude/`** — the CLI's own settings, agents, skills and plan files, inherited through
  `settingSources` rather than reimplemented. Lines never treats the ambient `~/.claude` login as
  a credential. This is also why hand-edited `.mcp.json` / user-settings MCP servers keep working
  unmodified — the UI-managed connection list
  ([mcp-connections](features/mcp-connections.md)) is additive on top of that path, not a
  replacement for it.

Every state change the browser needs travels as a `sessionUpsert`-shaped broadcast; `hello` is a
complete snapshot, which is why dropping a stream delta or closing a wedged link is safe.

## The trust boundary

Execution is local. The agent, the filesystem it edits, `git`, and the Claude OAuth token are all
on the user's machine. The hosted side relays and stores; it never runs a turn.

- **Clerk** authenticates the browser to the *hosted side*. On a direct socket the bridge verifies
  the token itself; on a relayed one the relay verifies it and the bridge does not re-verify (a
  second verifier would make every relayed connection depend on the user's machine reaching
  Clerk's JWKS).
- **What grants owner authority on a relayed channel is a pinned key, not the relay's word.** The
  relay used to be the auth edge: it named the user and the bridge believed it, so controlling the
  relay meant being able to drive any machine it brokered. The attested identity is now a routing
  hint; authority comes from a static key exchanged out of band at enrollment and held only on the
  two ends. A machine refuses any relayed owner channel that cannot present a pinned key, from its first
  launch — every browser enrols once, and there is no plaintext owner path. See [features/end-to-end-encryption.md](features/end-to-end-encryption.md).
- **Storage is a blob store that cannot author content, within limits.** Blobs this fleet pushes
  are signed and verified against a pinned signer with a monotonic counter, so a compromised
  database can delete, withhold or replay — not forge. Where a resource cannot carry a signature
  yet (maps merged in SQL, arrays), the defence is instead that nothing pulled is *applied*
  unreviewed: agent memory stages a diff, and an adopted session contributes no queued work and
  cannot raise its own permission mode.
- **Device pairing** binds a machine to a user. Only a hash of the machine's pairing secret
  reaches Postgres; the plaintext is generated on the machine and never leaves it. The relay holds
  no database credentials — it asks `storage/` to verify, and refuses the connection if storage is
  unreachable, so an outage can never widen access.
- **The permission guard** (`server/src/autoGuard.ts`) decides per tool call whether to
  auto-approve or prompt. `ExitPlanMode` and `AskUserQuestion` always prompt, in every mode, and
  can never be allowlisted. Every resolution records who made it.
- **Claude credentials** are the app's own OAuth tokens under `~/.lines-app/users/<id>/`. A turn
  that cannot resolve one is refused rather than falling back to the unrefreshable ambient CLI
  login.
- **OpenAI credentials** are codex's, not ours. Lines writes `$CODEX_HOME/auth.json` exactly
  once at login and never again — OpenAI rotates the refresh token on every refresh, so a second
  writer would clobber tokens fresher than its own. A codex turn therefore carries no credential
  at all; it carries a `CODEX_HOME`. See
  [features/openai-codex-sessions.md](features/openai-codex-sessions.md).

## Conventions worth knowing before reading a feature doc

- `shared/types.ts` holds the wire contract. Additive optional fields are routine; a new message
  type is a protocol bump — and so is removing or renaming a field a client renders, even though
  the type-level change looks additive-safe: a hosted client ships ahead of every installed bridge,
  and an older *bundle* still renders the old field name against a payload that no longer has it.
  `APP_PROTOCOL_VERSION` (browser↔bridge) and `PROTOCOL_VERSION` (bridge↔worker) are separate
  contracts on separate numbering; skew is surfaced (`protocolSkew`, `SkewBanner`) but not enforced.
- Pure, exported helpers over methods with hidden dependencies — most of `server/`'s test coverage
  is direct unit tests of functions that take plain data.
- Server-owned broadcast state over local optimistic UI state: the client derives affordances from
  the session it was sent.
- `web/` has no test runner. Anything client-only is verified by hand or through the `verify`
  skill.

## Related

- `docs/codebase/feature-index.md` — every feature document, with the older ids each absorbed.
- `docs/codebase/index.json` — the machine-readable index agents should start from.
- `.ai/CONVENTIONS.md` — the reading order every agent follows.
