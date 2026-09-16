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
  holds no database credentials. It verifies a device secret through storage and
  learns only the owning user id. Anything that lets a client bind to a user it
  does not own, or that gets a socket through without a valid device, is a
  serious finding. `RELAY_AUTH_DISABLED` exists for local development and must
  never be set in a deployment; reports that depend on it being set are not bugs.
- **Device pairing secrets** — a pairing secret is generated on the paired
  machine; storage keeps only a SHA-256 hash. Anything that recovers a plaintext
  secret, replays a pairing code, or pairs a machine to the wrong account is in
  scope.
- **Clerk tokens** — token handling in `storage/` and `relay/`, and in the
  browser bundle. Token leakage across users, missing verification on an
  authenticated route, or a route that trusts a client-supplied user id.
- **The local bridge and worker tokens** — the bridge and worker listen on
  localhost (`:8787` and `:8788`). Anything that lets another local process, a
  browser page, or a remote origin drive a turn, read a transcript, or reach the
  filesystem through them — including CSRF and DNS-rebinding style attacks on the
  local HTTP surface.
- **Agent credential containment** — the product promise is that a database
  compromise cannot leak an agent credential: the Claude OAuth token lives only
  in `~/.lines-app` on the user's own machine. Any path that puts a credential
  into Postgres, into a sync payload, or into a log is in scope, whatever the
  existing tests say.
- **Permission and approval enforcement** — a path that executes a tool call the
  user did not approve, or that escapes the configured permission mode or guard
  allowlist.

## What is out of scope

- Findings that require an attacker who already has local code execution as the
  user, or root on the user's machine. The agent runs with the user's own
  filesystem access by design.
- The macOS build being ad-hoc signed rather than notarized. Known, documented in
  `docs/codebase/features/desktop-app.md`, and tracked as a packaging matter.
- Vulnerabilities in the Claude or Codex CLIs, the agent SDKs, or any vendor
  service. Report those to the respective vendor; if Lines' use of one makes an
  issue materially worse, that part is in scope here.
- Missing hardening headers, rate limits, or best-practice findings from an
  automated scanner with no demonstrated impact.
