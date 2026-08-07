# Workflow step output consolidation

## Purpose

Ensure the output handed to the next workflow step ({previous}, outputName) is the step's full definitive deliverable, not a short delta reply left over from iterating on the step (feedback retry or follow-up).

## Entry points

- `server/src/workflows.ts` (`WorkflowEngine.advance`, `WorkflowEngine.runStep`)

## Files

- `shared/types.ts` (`WorkflowState.lastStepOutput`, `WorkflowState.diffBaselines`)
- `server/src/sessions.ts` (`SessionManager.consolidateStepOutput`)
- `server/src/workflows.ts`
- `server/src/git.ts` (`workingTreeDiff`/`multiRepoDiff`, `MAX_DIFF_CHARS` — see
  [multi-repo-commits](multi-repo-commits.md), which owns the per-repo diff and
  the new `{roots}` token in detail)

## Symbols

- `WorkflowState.lastStepOutput`
- `SessionManager.consolidateStepOutput`
- `SessionManager.consolidateQuery`
- `SessionManager.consolidateTimeoutMs`
- `SessionManager.lastAssistantText`
- `SessionManager.collectTurns`
- `SessionManager.findStepStart`
- `WorkflowEngine.advance`
- `WorkflowEngine.runStep`
- `substituteTokens`
- `usesHandoffTokens`

## Data flow

`advance()` calls `consolidateStepOutput(sessionId, stepIndex)` before moving to the next step, passing the index of the step that just finished. It locates *that step's* entry marker via `findStepStart` (the last `workflow` transcript event with `event === 'started'` and a matching `stepIndex`, scanning backwards so a re-entered step resolves to its latest pass), then slices the transcript from there and groups it into turns with `collectTurns` (each `user` event opens a turn). A turn's output is its `ExitPlanMode` deliverable when it produced one (the plan mode harness puts the plan in the `ExitPlanMode` tool input, or — in the current harness shape, which takes no `plan` argument — in the plan file the turn wrote under `~/.claude/plans/`), else its last assistant text block. `collectTurns` now takes an optional `roots` list (default `[]`); when a plan-mode turn's write is an `Edit` (which carries no `content` argument, only the tracked `file_path`) or when the file was revised again after the last `Write`, it re-reads that file's current text from disk — gated by `isPlanPath(filePath, roots)` and a size cap — and prefers it over whatever `content` was captured in the transcript. `SessionManager` supplies `roots` from the session's own project roots (`rootsFor`) at both call sites; a read that fails for any reason (deleted file, outside every root) degrades to the captured `content`, matching the prior, purely transcript-local behavior. A single-turn step returns that output directly — no query, no added latency. A multi-turn step (iterated via feedback retry or a follow-up) runs a one-shot Sonnet query (`consolidateQuery`, non-agentic: `maxTurns: 1`, no tools), given the step's initial instruction plus every attempt's output and the feedback between them, and asks it to produce one consolidated deliverable. That query — including the owner-token refresh it needs — is raced against `consolidateTimeoutMs` (60s default, a field so tests can shrink it); on timeout the race is abandoned (the query keeps draining in the background, unread) and `consolidateStepOutput` warns and falls through to the same `lastAssistantText` fallback used on any other failure. `advance()` awaits this whole call with `advancing` already broadcast, so an unbounded stall here used to leave the stepper showing a finished step with no next action — this bound is what actually enforces the method's "never blocks the workflow" contract.

An empty consolidated output is not published: it leaves `meta.workflow.lastStepOutput` and `outputs[outputName]` untouched rather than clobbering a previous non-empty value. A non-empty capture is persisted immediately (`SessionManager.persistMeta`) before the next step is queued, so a bridge crash between capture and the next transition can't lose it. `runStep()`'s fresh-start hand-off reads `lastStepOutput ?? lastAssistantText(...)`.

Before a step's prompt is sent, `runStep` resolves the hand-off values it will need (`{task}` from the workflow, `{feedback}` from a retry, and — only when entering a fresh-start step that has predecessors — `{previous}` from `lastStepOutput ?? lastAssistantText(...)` and `{diff}` from `multiRepoDiff`, one per-repo section per commit unit the session's roots span — see [multi-repo-commits](multi-repo-commits.md)), then calls `substituteTokens` **once** on the raw template. That single `String.replace` fills `{task}`, `{feedback}`, `{previous}`, `{diff}`, `{roots}`, and every `{outputs.<name>}` from `meta.workflow.outputs` (per-session, never shared across sessions) in one pass, so text pulled in by one token is never rescanned for another. An `{outputs.<name>}` that is absent or resolves to blank/whitespace is reported as missing; if any are missing the step parks at `waiting-approval` via `SessionManager.failTurn` (so the transcript gets a Retry-able failure row, `WorkflowState.stepFailure = 'pre-run'`) plus a marker carrying `missingOutputs`, and the prompt is never sent — see [turn-failure-retry](turn-failure-retry.md). `usesHandoffTokens(template)` (tested against the **template**, before substitution) gates the fresh-start auto-prepend so a template that already references `{previous}`, `{diff}`, or any `{outputs.*}` is not also handed the same context a second time under a `## Context from the previous step` heading. `{roots}` is deliberately **not** one of the tokens `usesHandoffTokens` looks for — it is static workspace shape (which folders, which git repos, which branches), not hand-off content, so a template using only `{roots}` still gets the normal auto-prepend, and `{roots}` itself is resolved independent of `handoff` (it also works in a step that inherits the conversation).

## Tests

- `server/src/sessions.turns.test.ts` — `collectTurns` (plan-mode capture, both harness shapes; plans-file write with no `ExitPlanMode`; revised plan; plain-text turn; a plan revised by `Edit` resolving from disk; an unreadable plan file degrading to the captured `Write` content; a plan file outside every root not being read) and `findStepStart` (per-step scoping, re-entry, fallback).
- `server/src/workflows.substitution.test.ts` — `usesHandoffTokens` and `substituteTokens` (fill, missing/blank detection, no-token no-op, the regression that tokens occurring inside substituted text are left literal, and that `{roots}` fills but is not itself a hand-off token).
- Run via `npm test` (root) or `npm run test -w server`; `tsx --test`, no new dependencies.

## Business rules

- Consolidation only fires when a step ran more than one turn; a single-turn step incurs no extra query or latency.
- On query failure, an empty result, or a timeout (`consolidateTimeoutMs`), falls back to `lastAssistantText` (per-step-scoped) rather than blocking the workflow.
- An empty consolidated output is never published — it can't overwrite a previously captured value.
- Consolidation runs on both a normal advance and a force-advance of a running step (see [workflow-force-advance](workflow-force-advance.md)), and is scoped to the step index that finished, not merely "the newest started marker" — relevant once a step can be queued while an earlier step's consolidation is still in flight.
- A step whose template references an `{outputs.<name>}` that is absent or blank never runs — it parks at `waiting-approval` with an error marker instead of silently substituting `''` and running blind.
- Tokens are only honoured where the step author wrote them: a token appearing inside substituted content (a step output, the diff, the task text) stays literal. Staged substitution used to re-expand them, so a plan that merely discussed `{previous}`/`{diff}` was pasted once per literal `{previous}` and the working-tree diff once per literal `{diff}` — one step produced a 3.8 MB prompt from a 13 KB plan and a 105 KB diff, and the turn failed for exceeding the context window.
- The working-tree diff handed to a fresh-start step is capped (`MAX_DIFF_CHARS` in `server/src/git.ts`) with a truncation marker, so a large dirty tree degrades the hand-off instead of failing the turn; when the session's roots span more than one commit unit, that one budget is shared across every repo's section rather than multiplied by the repo count (see [multi-repo-commits](multi-repo-commits.md)).
- A step's deliverable during plan mode is its `ExitPlanMode` plan (inline argument or written plan file), not the turn's trailing chat text — the prior behavior captured the latter and produced near-empty outputs.
- A plan revised by `Edit` after the deliverable-producing `Write` still contributes its current, on-disk text to the hand-off — not the last captured `Write` content or the turn's trailing chat text — since `collectTurns` reads the plan file from disk (gated by `isPlanPath`) whenever the turn saw `ExitPlanMode` and the write's path is known.
- `outputs` remain strictly per-session (`WorkflowState.outputs`); there is no cross-session write path. Perceived "leaking between sessions" was actually every session's `outputs.plan` being captured as the same short trailing-chatter string, then an implementation step improvising from `~/.claude/plans/` — a directory shared across all sessions on the machine.

## Architectural rules

- Reuses the transcript-walking pattern from `lastAssistantText`/`summarizeTurn` and the one-shot non-agentic query shape from `summarizeTurn`/`autoName`, rather than introducing a new query pattern.
- `advance()` is `async`; callers fire it with `void this.advance(sessionId)` since nothing downstream awaits its completion.
- `findStepStart`, `substituteTokens`, and `usesHandoffTokens` are pure functions (no `this.store`/network), enabling direct unit tests with synthetic transcript events. `collectTurns` is the one exception: it optionally reads a plan file from disk (`roots` defaults to `[]`, so existing callers that pass none keep the old transcript-only behavior), still with no `this.store` dependency — tests exercise the disk read by passing a real temp directory as `roots`.
- All prompt tokens are filled in one pass over the template rather than by chained `replaceAll` calls. Staged passes rescan what earlier passes inserted, which makes substituted content executable as template — any new token must be added to `substituteTokens`, not appended as another pass.
- Shipped step templates (`DEFAULT_WORKFLOW`'s "Implement MVP") tell the model to work only from the plan text supplied in the prompt and never read `~/.claude/plans/`; user-authored shared steps need the same edit made by hand in the UI, since they live in per-user storage, not the repo.

## Related decisions

- [multi-repo-commits](multi-repo-commits.md) — owns `{roots}`, `multiRepoDiff`,
  and the per-repo diff split budget in detail.
- [turn-failure-retry](turn-failure-retry.md) — the failure row and Retry the
  missing-`{outputs.*}` park now gets via `failTurn`.
