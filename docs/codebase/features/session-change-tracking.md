# Session change tracking

## Purpose

Answer "what has this session actually changed?" independent of workflows: a
per-session git baseline captured once at session creation, per-turn
attribution of which changed files belong to *this* session (not just to a
working tree it happens to share with another session), and a read-only review
UI that lists every changed file and diffs it on demand — without ever routing
diff content through a model.

Workflows already captured a baseline for their own `{diff}` hand-off (see
[multi-repo-commits](multi-repo-commits.md)), but that only existed while a
workflow was running and was never surfaced to a human. This feature lifts the
baseline to the session level so every session — workflow or not — has one, and
adds the attribution and UI layer on top.

## Entry points

- `server/src/sessions.ts` — `SessionManager.createSession` (captures the
  baseline), the prompt path (opens a turn's attribution window), the SDK
  `result` branch of `handleWorkerEvent` (closes it)
- `web/src/components/SessionView.tsx` — the "Review this session's changes"
  header icon
- `web/src/components/SessionDiffModal.tsx` — the review UI itself

## Files

- `server/src/git.ts` — `refExists`, `parseNameStatus`, `parseNumstat`,
  `changedFiles`, `showFile`, `changedBetween`
- `server/src/sessions.ts` — `collectChangedPaths`, `SessionManager`'s
  `captureSessionBaseline`, `baselinesFor`, `changeSummary`, `baselineRefFor`,
  `openTurnWindow`, `recordFilesChanged`, `sharedRepos`
- `server/src/fileRoutes.ts` — `readSessionDiff`, `readSessionDiffFile`,
  `sessionInReach`
- `shared/types.ts` — `SessionMeta.diffBaselines`/`diffBaselineAt`,
  `FilesChangedData`, `SessionDiffResponse`/`SessionDiffRepo`/`FileChange`,
  `SessionDiffFileResponse`, the `'files-changed'` transcript event kind, the
  `'sessionDiff'`/`'sessionDiffFile'` file-request kinds
- `web/src/lib/sessionDiff.ts` — `fetchSessionDiff`, `fetchSessionDiffFile`
- `web/src/components/SessionDiffModal.tsx` — the review UI

## Symbols

- `SessionManager.captureSessionBaseline(sessionId)` — fire-and-forget,
  `createSession`-only capture of one `RepoBaseline` per commit unit the
  session spans; never overwrites an existing `meta.diffBaselines`.
- `SessionManager.baselinesFor(meta)` — resolution order: the session's own
  `diffBaselines`, then a workflow's (`meta.workflow.diffBaselines`/legacy
  `diffBaseline`, for a session that predates the session-level baseline),
  then a synthesized `HEAD` per commit unit flagged `synthetic`.
- `SessionManager.openTurnWindow` / `recordFilesChanged` — bracket a turn with
  two git snapshots (start, settle) and diff them per commit unit
  (`changedBetween`), independent of what tool made the change. Emits one
  `'files-changed'` transcript event per turn that changed anything; skipped
  entirely for a turn with no tool calls.
- `SessionManager.sharedRepos(sessionId)` — commit units this session shares
  with another session that was active during the turn window; drives the
  `ambiguous` flag.
- `collectChangedPaths(events, roots)` — unions `files-changed` events with a
  `tool_use` scan (Write/Edit/MultiEdit/NotebookEdit, subagent blocks
  included) into `{ paths, ambiguous }`. A path a tool call names is claimed
  outright even if a window also saw it as ambiguous — direct evidence
  outranks the window's uncertainty.
- `changedFiles(repo, baseline)` (`git.ts`) — the structured diff for one repo:
  `git diff --name-status`/`--numstat` against the baseline ref, plus
  untracked files since it, capped by the existing `MAX_UNTRACKED`.
- `refExists(repo, ref)` — whether a `git stash create` snapshot ref still
  resolves; false after a `git gc` prunes it.

## Data flow

**Baseline.** `createSession` fires `captureSessionBaseline` once,
fire-and-forget; the result lands on `meta.diffBaselines`/`diffBaselineAt` and
rides the synced `SessionMeta` blob like every other session field.

**Per-turn attribution.** Every prompt send calls `openTurnWindow`, snapshotting
every commit unit the session spans into live (non-persisted) state. When the
SDK `result` message lands, `recordFilesChanged` takes a second snapshot,
diffs it against the first per repo, and — only if the turn made at least one
tool call — emits a `'files-changed'` transcript event with the changed
relative paths, each repo optionally flagged `ambiguous` if another active
session shared that commit unit during the window. This is
mechanism-agnostic: a shell redirect, a script, or an MCP tool writing a file
is caught the same as `Write`/`Edit`, because the diff content always comes
from git, not from reading tool arguments. `collectChangedPaths` is the
read-side union of these events with a `tool_use` scan, used as a fallback for
turns that never settled (a crash) or predate this feature.

**On-demand diff.** `SessionManager.changeSummary(sessionId)` resolves the
baseline chain, calls `changedFiles` per commit unit, and buckets each
changed file into `attributed` (in `collectChangedPaths`'s result) or `other`
(everything else uncommitted in that repo) — marking a path `ambiguous` when
it came only from an overlapped window. Served over the existing
[workspace-reads-over-the-WebSocket](file-routes-over-ws.md) plumbing via two
new `FileRequestKind`s: `sessionDiff` (the file list, no content) and
`sessionDiffFile` (one file's baseline + on-disk contents, fetched only when
the review UI opens that file).

**Review UI.** `SessionDiffModal` is a master-detail view: every changed file
in a sidebar (grouped "changed by this session" / collapsed "other
uncommitted"), one Monaco diff editor on the right for whichever file is
selected. Reaching the end of a file and scrolling past it rubber-bands into
the next/previous file instead of stopping, so reviewing a session's whole
change set is one continuous gesture without needing to guess or reflow the
height of every file up front. A file can be hidden per-viewing via an `✕` on
its row. Folding (`hideUnchangedRegions`) is tuned tighter than Monaco's
defaults so a file with changes scattered every few lines still collapses its
untouched stretches. The full-screen side-by-side `MonacoDiffModal` remains
reachable per file for a wider view.

## Dependencies

- [multi-repo-commits](multi-repo-commits.md) for `groupByRepo`,
  `captureBaseline(s)`, `repoBranch`, and the commit-unit concept this reuses
  rather than duplicates.
- [file-routes-over-ws.md](file-routes-over-ws.md) for the request/response
  transport and the async `handleFileRequest` dispatch this feature required.
- [session-collaboration](session-collaboration.md) for the `SocketAccess`
  grant shape `sessionInReach` clamps against.

## Tests

- `server/src/git.sessionDiff.test.ts` — `parseNameStatus`/`parseNumstat`
  against real `git diff` output shapes (renames, copies, typechange,
  binary/`-` numstat rows), no repo needed.
- `server/src/sessions.changedPaths.test.ts` — `collectChangedPaths`: the two
  sources unioned, subagent writes included, non-write tools ignored, a
  window-only path (the shell/MCP case) still attributed, ambiguous windows
  demoted unless a tool call also claims the path.
- `server/src/fileRoutes.test.ts` — `sessionDiff`/`sessionDiffFile` success
  and 403/404 paths, including the session-scope grant clamp.
- `server/src/guestAccess.test.ts` — updated for the now-async
  `handleFileRequest`.

Not yet covered: a live-turn integration test for `openTurnWindow`/
`recordFilesChanged` (needs a running worker), and a `baselinesFor` precedence
test through `WorkflowEngine` — the workflow-visible baseline path itself is
unchanged (see Business rules).

## Business rules

- One baseline per session, captured once at creation, never recaptured or
  overwritten — a later re-run of the capture (e.g. a duplicate call) is a
  no-op once `meta.diffBaselines` is set.
- Baseline resolution order is session → workflow → synthetic `HEAD`; a
  synthetic baseline is flagged so the UI can say "no baseline was recorded —
  showing all uncommitted work in this repository" rather than presenting a
  stranger's dirty tree as this session's own.
- A pruned snapshot ref (`git gc` after a long-lived session) falls back to
  `HEAD` and is flagged `stale`, never silently rendered as "nothing changed."
- A path is `ambiguous` only when every source that saw it is an overlapped
  turn window; a direct `tool_use` claim always wins, even against an
  ambiguous window for the same path.
- `sessionDiff`/`sessionDiffFile` require the session itself to be inside the
  connection's grant (`sessionInReach`), not just the `readFiles` capability —
  these routes return contents from the host's working tree, so a
  session-scope guest must not read a sibling session's changes.
- No `MAX_DIFF_CHARS`-style cap applies to this path: that cap exists to
  protect a model's context window, and nothing here reaches a model.
- Workflow `{diff}` behavior is **unchanged** by this feature —
  `WorkflowState.diffBaselines` is still written and read exactly as before
  (see [multi-repo-commits](multi-repo-commits.md)). Session-level tracking is
  read-only and additive.

## Architectural rules

- Diff assembly (baseline resolution, attribution, bucketing) lives on
  `SessionManager` in `sessions.ts`, not in `fileRoutes.ts` — the route stays a
  thin permission clamp over it, matching how every other file route is a pure
  function of `(ctx, params, access)`.
- `git.ts` stays pure git with no prompt formatting, per its existing rule
  (see [multi-repo-commits](multi-repo-commits.md)); `parseNameStatus`/
  `parseNumstat` are exported pure functions for the same reason
  `parseWorktreeList` is in `worktrees.ts`.
- Per-turn attribution (`'files-changed'`) is a transcript event, never a
  `SessionMeta` field — that blob is synced, and a per-turn path list would
  grow it unboundedly. It exists in the transcript stream but is deliberately
  never rendered as a card (see
  [transcript-rendering](transcript-rendering.md)).
- `handleFileRequest` and its `ROUTES` map are now async (`FileRouteResult |
  Promise<FileRouteResult>`), widened once for both new kinds; every existing
  handler is unchanged and still returns synchronously.

## Related decisions

- [multi-repo-commits](multi-repo-commits.md) — the commit-unit/baseline
  primitives this reuses
- [file-routes-over-ws.md](file-routes-over-ws.md) — the transport and the
  async dispatch change
- [transcript-rendering](transcript-rendering.md) — where `'files-changed'`
  lives in the event stream
- [session-collaboration](session-collaboration.md) — the grant clamp on the
  two new file-request kinds

## Risks / open items

- **Shared (non-worktree) checkout.** Two sessions writing into the same work
  tree each see the other's concurrent writes inside their own turn window;
  those paths land in `ambiguous`, never claimed outright. Worktree-backed
  sessions can't collide this way.
- **A turn that never settles emits no window.** Its shell/script-made changes
  fall back to "other" rather than "changed by this session" (file-tool writes
  are still attributed via the `tool_use` scan backstop).
- **Snapshot cost on a large dirty tree.** `git stash create` writes tree
  objects proportional to the dirty file count, twice per turn per commit
  unit; gated on the turn having made a tool call and never awaited, but a
  session with thousands of dirty files pays it every turn.
- **Empty repo (no commits).** Pre-existing gap carried over from
  `multiRepoDiff`: `HEAD` doesn't exist, so tracked changes read as empty while
  untracked files still show.
- **Guest exposure.** `sessionDiff` returns host-machine file contents; gated
  on `readFiles` *and* `sessionInReach` — a wrong clamp here would let a
  session-scope guest read another of the host's sessions.
