# Claude UI

Local web GUI for the Claude CLI. React + Mantine frontend, thin Node bridge that drives
Claude sessions through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)
and streams everything to the browser over WebSocket.

## Features

- **Sessions sidebar** — create sessions per project directory, live status badges
  (running / needs permission / needs approval / error), parallel sessions.
- **Streaming output** — token-level streaming into a markdown transcript.
- **Modes & models** — toggle Agent / Accept edits / Plan / Bypass and switch models
  mid-session from the composer.
- **Tool calls** — collapsed cards per tool call; `Edit`/`Write`/`MultiEdit` show
  +N/−N stats and zoom into a full-screen **Monaco diff editor** (pre-edit content is
  snapshotted server-side via a PreToolUse hook, so diffs are faithful).
- **Permission prompts** — tool permission requests appear inline with Allow / Deny.
- **Workflows** — define multi-step run recipes (e.g. Plan → Implement MVP → Tests →
  Refactor → Review, shipped as default). Each step has its own prompt template
  (`{task}`, `{feedback}` placeholders), model, permission mode, and auto/manual
  advance. Manual steps gate on your Approve / Retry-with-feedback.
- **Caveman mode** — [caveman](https://github.com/JuliusBrussee/caveman) token-saving
  plugin vendored automatically and enabled per session (default on, level
  lite/full/ultra). Falls back to prompt injection if the plugin can't be cloned.
- **Persistence** — sessions, workflows, and JSONL transcripts live in `~/.claude-ui/`;
  transcripts replay on page load and sessions resume across server restarts via the
  CLI session id.

## Requirements

- Node 20+
- Claude Code CLI authenticated on this machine (the Agent SDK bundles the CLI binary
  and reuses your existing login)
- `git` (for vendoring the caveman plugin; optional)

## Run

```sh
npm install
npm run dev
```

Open http://localhost:5173. The bridge server listens on `:8787`, the worker on `:8788`.

## Layout

```
shared/   WS protocol + shared types
server/   src/worker.ts        thin worker: owns the SDK queries / CLI children
          src/workerProtocol.ts bridge<->worker wire protocol (keep minimal!)
          src/workerClient.ts  bridge-side worker connection
          src/index.ts,        Node bridge: SessionManager, WorkflowEngine,
          src/sessions.ts, …   permissions/guard, JSONL/JSON persistence
web/      Vite + React + Mantine SPA: sidebar, transcript, Monaco diffs,
          workflow stepper/editor
```

## Notes

- **Two server processes.** The *worker* (`:8788`) owns every SDK query — and thus
  every Claude CLI child process. The *bridge* (`:8787`) holds all business logic and
  can restart freely (tsx watch, crashes, dogfooding edits to its own code) without
  killing in-flight agent turns: it reconnects to the worker, events buffered during
  the gap replay, and unanswered permission requests are re-delivered. The worker's
  import graph is deliberately tiny (`worker.ts` + `workerProtocol.ts` + SDK), so its
  own tsx watch only restarts it when those files change.
- Each session holds one long-lived streaming SDK query; interrupts, model switches,
  and permission-mode switches apply live. Toggling caveman restarts the query
  (context is preserved via `resume`).
- State is stored in `~/.claude-ui/{sessions.json,workflows.json,transcripts/*.jsonl}`.
