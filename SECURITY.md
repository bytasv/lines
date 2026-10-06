# Security Policy

## Reporting a vulnerability

Report privately through **GitHub Security Advisories**: open the repository's
**Security** tab and choose **Report a vulnerability**. That is the only private
channel — there is no security email address.

Please do not open a public issue, pull request, or discussion for a suspected
vulnerability. A public report is itself the disclosure.

Include what you have: affected version or commit, the component (bridge, worker,
relay, storage, desktop app, or web bundle), how the issue is reached, and what
an attacker gains. A minimal reproduction helps more than a long writeup. If you
have a suggested fix, say so — but a report without one is still welcome.

Expect an acknowledgement within a few days. Lines is maintained by one person,
so please allow reasonable time for a fix before disclosing publicly; the
advisory thread is the place to agree on timing and on credit.

## Supported versions

Only the latest release and the current `main` receive security fixes. There are
no long-term support branches.

## What is in scope

Lines is deliberately split so the hosted side holds as little as possible. The
surfaces most worth your attention:

- **Relay authentication** (`relay/`) — the relay is the most exposed process and
  holds no database credentials. It verifies a device secret (sent in a request
  header, never the URL) through storage and learns only the owning user id.
  Anything that lets a client bind to a user it does not own, or that gets a
  socket through without a valid device, is a serious finding.
  `RELAY_AUTH_DISABLED` exists for local development and must never be set in a
  deployment; reports that depend on it being set are not bugs.
- **What a compromised relay can do** — the design goal is: drop, delay and count
  traffic, and nothing more. An owner channel authenticates end to end against a
  key the machine pinned at enrollment; a guest channel against the machine key
  in the guest's invite link, and is admitted only on a grant the machine minted
  itself, which the relay can narrow but never widen. Anything that lets the
  relay read or forge app traffic, admit a guest, or widen a guest's access is in
  scope. Two things are still the relay's word by design: which account a guest
  signed in with (used for attribution) and the connection metadata it sees.
- **Device pairing secrets** — a pairing secret is generated on the paired
  machine; storage keeps only a SHA-256 hash. Anything that recovers a plaintext
  secret, replays a pairing code, or pairs a machine to the wrong account is in
  scope.
- **Clerk tokens** — token handling in `storage/` and `relay/`, and in the
  browser bundle. Token leakage across users, missing verification on an
  authenticated route, or a route that trusts a client-supplied user id.
- **The local bridge and worker** — both listen on 127.0.0.1 only (ephemeral
  ports, published in `~/.lines-app/run`; `:8787`/`:8788` under Tilt). The worker
  requires a per-boot token. The bridge accepts a browser WebSocket only from a
  page this machine serves (a loopback origin, from loopback), refuses a Host
  header that does not name this machine (DNS rebinding), and in the desktop
  app's relay mode accepts no direct socket at all. Anything that lets a browser
  page, another origin or a network peer drive a turn, read a transcript, or
  reach the filesystem through them is in scope. Opening the bridge to a LAN is
  an explicit opt-in (`LINES_BRIDGE_HOST`, `LINES_BRIDGE_ALLOWED_ORIGINS`) and
  out of scope while it is set.
- **Agent credential containment** — the product promise is that a database
  compromise cannot leak an agent credential: the Claude login, the Codex
  `auth.json`, MCP header and environment values and the TypeSafe key live only
  in `~/.lines-app` (owner-only) on the user's own machine, and storage receives
  the names of MCP headers and environment variables, never their values. Any
  path that puts a credential into Postgres, into a sync payload, or into a log
  is in scope, whatever the existing tests say. (Releases before 2026-10-06
  synced MCP stdio environment values; storage no longer accepts or returns them
  and a migration removed the stored ones.)
- **Synced content** — what comes back from storage is signed by the machine
  that wrote it. A workflow, step or recipe that is unsigned, altered, or signed
  by a machine the user has not trusted is held back from running until the user
  has reviewed it; the settings, guard allowlist and MCP server list are refused
  when their signature fails, and a remote allowlist or MCP list is only ever
  staged for the user to accept. A path that makes storage-written content run,
  or that widens what it may do (permission mode, allowlist), is in scope.
- **Permission and approval enforcement** — a path that executes a tool call the
  user did not approve, or that escapes the configured permission mode or guard
  allowlist.

## What is out of scope

- Findings that require an attacker who already has local code execution as the
  user, or root on the user's machine. The agent runs with the user's own
  filesystem access by design.
- Other accounts on a shared machine. The bridge's loopback port is reachable by
  any local process, and a non-browser client is not authenticated beyond that;
  Lines assumes a single-user machine.
- Vulnerabilities in the Claude or Codex CLIs, the agent SDKs, or any vendor
  service. Report those to the respective vendor; if Lines' use of one makes an
  issue materially worse, that part is in scope here.
- Missing hardening headers, rate limits, or best-practice findings from an
  automated scanner with no demonstrated impact.
