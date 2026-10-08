# Contributing to Lines

Thanks for taking the time. This document covers getting the repo running, the
conventions the codebase already follows, and the licensing terms a contribution
is offered under.

## Getting set up

Requirements: Node 20+, `git`, and — for anything that actually runs an agent
turn — an authenticated Claude Code CLI on the same machine.

```sh
npm install
npm run generate -w storage   # Prisma client; see the note below
npm run dev
```

Open http://localhost:5173. The bridge listens on `:8787`, the worker on `:8788`.
`tilt up` is the alternative runner and shows bridge and worker as separate
resources with readiness probes.

**Run `prisma generate` explicitly.** `storage` declares it as a `postinstall`
script, but many setups (and CI here) run npm with `ignore-scripts` enabled, in
which case `npm install` silently skips it and `storage` dies at `$connect()`
with a missing-client error. Running it by hand is always safe.

## Repository layout

Six npm workspaces in one repo:

| Workspace | What it is |
|---|---|
| `shared/` | types shared across every other workspace; no runtime code |
| `server/` | the bridge (business logic, HTTP/WS API) and the worker (owns every agent SDK query) |
| `web/` | the React/Mantine browser app |
| `relay/` | frame pipe for the hosted deployment; parses nothing, persists nothing |
| `storage/` | Clerk-authed Express + Prisma API for cross-machine sync |
| `desktop/` | Electron menu-bar shell supervising the bridge and worker |

`deploy/` holds the Docker/Traefik compose stack for the hosted server side.

Two rules that are easy to trip over and expensive to undo:

- **The worker stays thin.** Business logic belongs in the bridge, which can
  restart freely without killing an in-flight turn. Anything you put in the
  worker cannot be reloaded while a turn is running.
- **Agent credentials never reach Postgres.** `storage/src/schema.credentials.test.ts`
  fails CI if a credential-shaped column appears in the Prisma schema, and
  `server/src/sync.credentials.test.ts` proves the bridge never puts a secret on
  the wire. If you need to add something that looks secret-shaped, that is a
  design conversation, not an allowlist entry.

## Before you open a pull request

```sh
npm run typecheck
npm test
```

Both must pass. Tests are `node:test` via `tsx`, colocated as `*.test.ts` next to
the code they cover.

Git hooks in `.githooks/` run the same checks CI does: `pre-commit` runs the root
typecheck (and `docs:validate` when `docs/codebase/` is staged), `pre-push` to
`main` adds the migration-safety check, the server, relay, storage and desktop
unit tests, and a scratch `vite build` of the web app. `npm install` enables them
via `prepare`; with `ignore-scripts` set, run
`git config core.hooksPath .githooks` once yourself. Skip a run with
`--no-verify` or `LINES_SKIP_HOOKS=1`.

**Update `docs/codebase/` when behaviour changes.** Per `.ai/CONVENTIONS.md`, the
documentation corpus is a navigation aid for areas touched by completed work: if
your change adds or alters an entry point, a symbol, or a test that an existing
feature document names, update that document and `docs/codebase/index.json` in
the same pull request. Do not create a new feature document for work that has no
runtime entry point.

## Commits

This repository uses [Conventional Commits](https://www.conventionalcommits.org/),
scoped by workspace:

```
feat(server,web): browse spend by day/week/month/year
fix(dev): complete independent Tilt runner shutdown and recovery
chore(desktop): bump version to 0.2.3
```

Keep the subject imperative and under about 72 characters. Use the body for the
*why* when it is not obvious from the diff.

## Licensing of contributions

Lines is licensed under the [GNU Affero General Public License v3.0](LICENSE),
with an [additional permission](LICENSE-EXCEPTION) under section 7 of the GPL for
combining the program with agent provider software.

**Inbound equals outbound.** Unless you state otherwise in writing, a
contribution you offer for inclusion in Lines is offered under the AGPL-3.0
together with that additional permission, and the maintainers may issue later
versions of the exception applying to the program as a whole. This mirrors
section 5 of `LICENSE-EXCEPTION`, and it is what keeps the exception amendable —
for example, to name a new agent vendor — without needing every past
contributor's consent.

**Sign off your commits (DCO).** Every commit must carry a `Signed-off-by` line
certifying the [Developer Certificate of Origin](https://developercertificate.org/):

```sh
git commit -s -m "fix(server): ..."
```

which appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

Use your real name and an address you can be reached at. If you forgot, amend
with `git commit --amend -s` (or `git rebase --signoff` for a range) and
force-push the branch.

## Security

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
