# Lines

A web GUI for the Claude Agent SDK / Claude Code CLI. Run, watch, and steer multiple
Claude sessions in parallel from the browser — live token streaming, inline diffs,
multi-step workflows, and a reusable prompt library — while the agent itself always
runs on your own machine, with your own filesystem, `git`, and Claude login.

Three ways to run it: **locally** (`npm run dev`), as an installable **desktop app**
(menu-bar, no terminal), or **hosted** — a web app your browser talks to from
anywhere, while the agent still executes on a machine you paired, not in the cloud.

## Capabilities

- **Sessions & live streaming** — create sessions per project directory, run several
  in parallel, live status badges (running / needs permission / needs approval /
  error), token-level streaming into a markdown transcript.
- **Tool calls, made readable** — every tool call renders as a structured card (not
  raw JSON); `Edit`/`Write`/`MultiEdit` show +N/−N stats and zoom into a full-screen
  **Monaco diff editor** with faithful pre-edit snapshots; subagent (`Task`) output
  nests under its spawning card instead of flattening the transcript.
- **Permissions, your way** — tool permission requests appear inline with
  Allow/Deny; an **auto-mode guard allowlist** lets you pre-approve safe patterns
  (synced across your machines with explicit review, never silently applied); plan
  review (`ExitPlanMode`) and questions (`AskUserQuestion`) always still ask.
- **Workflows** — multi-step run recipes (e.g. Plan → Implement → Tests → Review,
  shipped as a default) with per-step prompt templates, model, permission mode, and
  auto/manual advance; stuck steps have a one-click recovery (force-advance / resume
  a stalled step) so a workflow never gets permanently wedged.
- **Recipes** — a shareable prompt library, independent of workflows: publish a
  versioned prompt (with tags and screenshots), browse everyone's published recipes,
  and run one standalone, inside an existing workflow, or combine several into a
  bundle (e.g. "infra + auth + database + payments") that runs as a synthesized
  workflow.
- **Model & permission-mode control** — switch models and Agent/Accept-edits/Plan/
  Bypass mid-session, per session or per workflow step; a retired model id still
  runs (auto-remapped) with a warning badge to update it.
- **Usage & cost visibility** — a plan-usage chip (5-hour/weekly windows, spend by
  model), per-session cost/tokens/duration in the sidebar, and per-step cost in the
  workflow stepper — so you always know what a session or step is costing.
- **Context window management** — a live context-occupancy ring in the composer with
  a breakdown of what's filling it, a near-limit warning, and a manual "Compact now"
  to summarize and continue instead of hitting the wall mid-turn.
- **Multi-root, multi-repo projects** — one project tab spans several folders;
  workflow steps that commit group changes by git work tree, not by project, so a
  multi-repo change lands as separate, correct commits.
- **Turn recovery** — every recoverable failure (a crashed query, an `is_error`
  result, a dead OAuth token, an app restart mid-turn) gets a one-click Retry or an
  auto-resume banner instead of a dead session.
- **Docs reader** — an in-app reader for a project's `docs/**`: doc tree, feature
  cards, full-text search, in-reader cross-links — this README's own docs corpus is
  built to be read this way.
- **Agent memory sync** — your `~/.claude` memory (global `CLAUDE.md` + per-project
  auto-memory) syncs across machines via the storage server, so context follows you
  rather than living on one disk.
- **Caveman mode** — [caveman](https://github.com/JuliusBrussee/caveman) token-saving
  plugin, vendored automatically and enabled per session (default on, level
  lite/full/ultra); falls back to prompt injection if the plugin can't be cloned.
- **Persistence** — sessions, workflows, recipes, and JSONL transcripts live in
  `~/.lines-app/`; transcripts replay on load and sessions resume across restarts.

## Ways to run it

| Mode | What it is | Where the agent runs |
|---|---|---|
| **Local dev** | `npm run dev` under Tilt/concurrently, open `localhost` | your machine |
| **Desktop app** | menu-bar app, no terminal, ships an installer | your machine |
| **Hosted** | web app reachable from any browser, gated by Clerk sign-in + device pairing | a machine you paired — the hosted side runs only the relay, storage, and static bundle; never your code |

The hosted deployment's bridge dials **out** to a relay (no inbound port, NAT, or
dynamic DNS needed on your machine); pairing binds that machine to your account so
the relay refuses unclaimed or wrongly-claimed connections.

## Requirements

- Node 20+
- Claude Code CLI authenticated on the machine that runs the agent (the Agent SDK
  bundles the CLI binary and reuses your existing login)
- `git` (for vendoring the caveman plugin, and for diff/commit features; optional
  otherwise)

## Run (local dev)

```sh
npm install
npm run dev
```

Open http://localhost:5173. The bridge listens on `:8787`, the worker on `:8788`.
(`tilt up` runs the same four processes with readiness probes and hot-reload
freezing during a live turn — see `Tiltfile`.)

## Layout

```
shared/   WS protocol + shared types
server/   src/worker.ts        thin worker: owns the SDK queries / CLI children
          src/workerProtocol.ts bridge<->worker wire protocol (keep minimal!)
          src/workerClient.ts  bridge-side worker connection
          src/index.ts,        Node bridge: SessionManager, WorkflowEngine,
          src/sessions.ts, …   RecipeEngine, permissions/guard, persistence
web/      Vite + React + Mantine SPA: sidebar, transcript, Monaco diffs,
          workflow stepper/editor, recipe library, docs reader
relay/    Outbound-relay for the hosted deployment: pipes frames between a
          bridge (dials out) and a browser (/client) — see docs/codebase/features/hosted-machine-access.md
storage/  Hosted storage server: Postgres (Prisma) + device pairing, cross-machine
          sync for sessions/workflows/recipes/agent memory
desktop/  Electron menu-bar shell: supervises bridge+worker as local children,
          or runs relay-only in hosted mode — see docs/codebase/features/desktop-app.md
deploy/   Docker/Traefik compose for the hosted server side (relay+storage+web only;
          the agent never runs on this host) — see docs/codebase/features/production-deployment.md
```

Full feature-by-feature documentation lives under `docs/codebase/` (also browsable
in-app via the docs reader). Start with `docs/codebase/architecture.md` for the
bridge/worker split, the five deployables, where state lives, and the trust
boundary; `docs/codebase/feature-index.md` is the per-feature index.

## Notes

- **Two server processes, always.** The *worker* owns every SDK query — and thus
  every Claude CLI child process. The *bridge* holds all business logic and can
  restart freely (tsx watch, crashes, dogfooding edits to its own code) without
  killing in-flight agent turns: it reconnects to the worker, buffered events replay,
  and unanswered permission requests are re-delivered. This split holds in every
  mode — local, desktop, and hosted.
- Each session holds one long-lived streaming SDK query; interrupts, model switches,
  and permission-mode switches apply live. Toggling caveman restarts the query
  (context is preserved via `resume`).
- Local state lives in `~/.lines-app/{sessions.json,workflows.json,recipes.json,
  transcripts/*.jsonl}`; the hosted deployment additionally mirrors sessions,
  workflows, recipes, guard allowlists, and agent memory to Postgres for
  cross-machine sync, with disk as the SDK-facing source of truth.
