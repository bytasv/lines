# Cross-provider model switching

Covers: `provider-switch`.

## Purpose

`setModel` refuses a cross-provider change once a session has run — nothing carries a
conversation between a `claudeSessionId` and a `codexThreadId`, so a naive switch would
leave a continuous-looking transcript in front of a model that has never seen it. Until
now that refusal was the only answer: "start a new session".

`SessionManager.switchProvider` is the deliberate way past it, for a user mid-session who
wants a second opinion from the other vendor or is hitting a rate limit on one account.
It drops the stranded conversation, summarizes it with a one-shot helper query, and seeds
the fresh conversation with that summary as a hand-off prompt — the same mechanism a
cross-provider workflow step already used (`WorkflowEngine.runStep`'s `crossesProvider`
handling). The summary is **lossy by design**: the transcript keeps a durable marker
saying so, and the confirm dialog says so before the click.

`setModel`'s refusal is untouched and stays strict — every other caller (notably
`WorkflowEngine.runStep`, which calls it unconditionally on every step) relies on it as a
data-integrity invariant. `switchProvider` is a second, more deliberate entry point, not a
flag that loosens the first one.

## Entry points

- Composer's model `<Select>` — picking a model on the other provider, on a session that
  has already run, opens a confirm dialog instead of dispatching `setModel` directly.
- `ConfirmModal`'s **Switch and summarize** button.

## Files

- `shared/types.ts` — `providerSwitchBlock`, `ProviderSwitchBlockCode`/`Info`,
  `ProviderSwitchData`, `'provider-switch'` transcript kind, `ClientMessage`'s
  `switchProvider`, `MESSAGE_AUTHZ.switchProvider`, `WorkflowState.providerSwitched`
- `server/src/sessions.ts` — `SessionManager.switchProvider`, `handoffSummary`,
  `handoffQuery`, `handoffPrompt`, `awaitInterruptSettled`, `withoutProviderSwitchSpans`,
  `switchingProvider` guard set
- `server/src/workflows.ts` — `WorkflowEngine.runStep`'s `providerSwitched` handling
- `server/src/index.ts` — routes `switchProvider` to `SessionManager.switchProvider`
- `server/src/helperQuery.ts` — `helperCwd()` (see Architectural rules)
- `web/src/components/Composer.tsx` — the confirm dialog, `stepAfterProviderSwitch`
  wiring, `modelWarn`/`cliWarning`
- `web/src/lib/format.ts` — `stepAfterProviderSwitch`
- `web/src/lib/transcript.ts` — the `'provider-switch'` builder case, folding the seed
  prompt into `ProviderSwitchItem.handoff`
- `web/src/components/Transcript.tsx` — `ProviderSwitchMarker`

## Symbols

- `providerSwitchBlock(meta)` — the shared predicate (composer disabled-option reason +
  server guard), in `rewindBlock`'s shape. Refuses `step-advancing` (a workflow advance
  is consolidating), `advance-pending` (a force-advance or approved plan is already
  waiting on this turn), and `queued` (prompts written against the conversation about to
  be dropped). Deliberately does **not** refuse on a live turn or on a workflow session —
  see Business rules.
- `SessionManager.switchProvider(sessionId, model, by)` — the whole operation, described
  under Data flow. `by` carries `actor`, `canSetModel`, `needsApproval` — the half of the
  authz decision `MESSAGE_AUTHZ` cannot express with one cap (see
  [session-collaboration](session-collaboration.md)).
- `handoffSummary`/`handoffQuery` — summarize the whole transcript (`collectTurns` from
  turn 0) into a briefing under ~120 words, with per-field and total character caps and
  a hard output cap. Falls back to `lastAssistantText`, then a fixed "no summary could be
  produced" note — never blocks the switch.
- `withoutProviderSwitchSpans(events)` — strips a switch's marker and the seed turn it
  opened from a transcript scan, mirroring `withoutCompactSpans`. Composed with it in
  `consolidateStepOutput` and `lastAssistantText`, so the seed's acknowledgement can never
  become a workflow step's consolidated output or the next step's `{previous}` hand-off.
  Deliberately **not** applied inside `handoffQuery`'s own scan — a second switch
  summarizes everything the current model can actually see.
- `WorkflowState.providerSwitched` — one-shot flag set when a switch happens on a
  workflow session; consumed by `runStep` so the next step, if it would otherwise cross
  back and park as an authoring-mistake failure, starts fresh instead. Cleared on every
  step entry regardless of whether it fired.
- `ProviderSwitchData.fromSessionId` — the resume pointer (`claudeSessionId` or
  `codexThreadId`) the switch abandoned, captured before `resetClaudeSession` clears it.
  Lives on the transcript event, not `SessionMeta` — it names a file in this machine's
  own CLI store, and `SessionMeta` syncs last-write-wins across machines. Consumed by a
  rewind that crosses back over the marker; see [session-rewind](session-rewind.md).

## Data flow

1. `switchProvider` resolves `from`/`to` providers. Same provider → delegates straight to
   `setModel` (this is not a provider switch).
2. Authz half `MESSAGE_AUTHZ` cannot express: refuses `by.canSetModel === false` and
   `by.needsApproval` (the seed prompt below goes through `prompt()`, bypassing
   `userPrompt`'s approval staging).
3. `providerSwitchBlock(meta)`.
4. CLI availability on the target provider (`codexCliRefusalMessage()` /
   `claudeCliRefusalMessage()`) — asked here rather than left to fail the first turn,
   because after the reset a failed first turn means the conversation is gone with
   nothing to replace it.
5. OpenAI account connected, when switching to `openai` (no equivalent check going the
   other way — the Claude path falls back to the CLI's own ambient login).
6. Claims the `switchingProvider` guard (mirrors `rewinding`/`compacting`), before the
   first `await`.
7. **A live turn is stopped, not refused.** `interrupt(sessionId)`, then
   `awaitInterruptSettled` polls `this.interrupting` clearing — the same edge that fires
   `onTurnComplete` and parks a running workflow step. Refuses `turn-running` if it never
   settles within `interruptSettleMs` (10s, a field so tests can shrink it) — nothing has
   been destroyed at that point.
8. Re-checks the workflow's current step is not still `'running'` after the settle — the
   one shape where the seed prompt below could be mistaken for the step's own turn.
9. `handoffSummary` runs (see Symbols). The abandoned pointer is read *before* the reset.
10. `resetClaudeSession(sessionId)`, then `setModel(sessionId, resolved)` — passes now
    because both resume pointers are clear (the same two-step `WorkflowEngine.runStep`
    already performs for a crossing step).
11. Emits `'provider-switch'` with `from`/`to`/`summarized`/`fromSessionId`.
12. Sets `workflow.providerSwitched = true` when the session has one.
13. Seeds with `prompt(sessionId, handoffPrompt(...), 'workflow', [], [], by.actor)` —
    `source: 'workflow'` reused rather than a third value, since its only two
    behavioural effects (skip auto-name, skip interrupted-advance clear) are both no-ops
    here.

## Dependencies

- `runHelperQuery`/`helperCwd()` (`server/src/helperQuery.ts`) — the summary is a
  one-shot, tool-free helper query on whichever provider is preferred (the *old*
  provider, since `helper()` is called before `setModel`).

## Tests

- `server/src/sessions.switchProvider.test.ts` — the whole gate, atomically (model and
  pointers unchanged on every refusal path); the stop-then-switch path and a stop the
  worker never answers; the hand-off summary's fallback chain (null answer, timeout);
  concurrent switches refused by the guard; `withoutProviderSwitchSpans`.
- `server/src/workflows.providers.test.ts` — a step that would cross back after a switch
  starts fresh (`providerSwitched` consumed) instead of parking as an authoring mistake;
  the flag is one-shot and cleared regardless.
- `server/src/sessions.codex.test.ts` — `switchProvider` as the way past `setModel`'s
  cross-provider refusal.
- `server/src/sessions.rewind.test.ts` — rewinding above a `provider-switch` marker (see
  [session-rewind](session-rewind.md)).

## Business rules

- A cross-provider switch is **lossy**: the summary is capped to roughly six bullets
  under 120 words, and the transcript's `'provider-switch'` marker is the only durable
  signal that everything above it is invisible to the model below — it renders even when
  the summary failed.
- Unlike `rewindBlock`, `providerSwitchBlock` does **not** refuse on a live turn or on a
  workflow session in any state. A live turn is stopped first (see Data flow); a workflow
  session's own state (`advancing`/`advanceOnComplete`) is what actually blocks, because
  those are the states with nothing to interrupt or a pending advance that stopping would
  corrupt.
- The switch is **one-shot** for a workflow session: the next step still runs on the
  model that step names (`runStep` re-applies it unconditionally). `providerSwitched`
  only stops that step from parking as an authoring mistake; it does not make the switch
  sticky for the run.
- The confirm dialog states the loss plainly and, on a workflow session, whether the next
  step will hand the model straight back and whether that step will restart fresh (see
  `stepAfterProviderSwitch`).
- CLI availability is checked for the *target* provider before anything destructive —
  ordering here is the single highest-severity property in the whole feature: any refusal
  added later must go above `resetClaudeSession`, never below it.
- A guest whose prompts need approval (`promptNeedsApproval`) is refused outright, because
  the seed prompt bypasses that staging.

## Architectural rules

- Helper queries (`runHelperQuery`, including the hand-off summary) run in an empty
  scratch directory (`helperQuery.ts`'s `helperCwd()`), never the session's own `cwd`.
  Both CLIs pull ambient context from wherever they start — Claude's auto-memory from
  `~/.claude/projects/<sanitized-cwd>/memory/`, codex's `AGENTS.md` from its working
  directory — and a helper asked to summarize one conversation must not fold in a
  project's memory or agent instructions. Measured, not theoretical: an early version of
  the hand-off summary recited this repo's own `MEMORY.md` entries for a two-line
  conversation.
- `switchingProvider` is claimed before the stop, not merely before the summary:
  `interrupt()` sets the session's status to idle synchronously, well before the CLI has
  actually stopped, so a prompt landing in that window would open a turn on the
  conversation about to be dropped. It is folded into `isBusy`/`canInterject`/
  `maybeFlush` alongside the existing `rewinding`/`compacting` guards.
- `forkCodex` (`server/src/workerCodex.ts`) takes an optional explicit `threadId`, used
  only when a rewind crosses back over a switch and needs to fork a thread the worker
  holds no live binding for (see [session-rewind](session-rewind.md)).

## Related decisions

- [openai-codex-sessions](openai-codex-sessions.md) — `setModel`'s refusal and the
  provider-capability table this switch has to respect.
- [model-selector](model-selector.md) — the picker's warning-icon treatment for a
  provider whose CLI is not installed, separate from this feature's confirm dialog.
- [session-rewind](session-rewind.md) — a rewind above a `provider-switch` marker
  restores the abandoned conversation and model, when the marker recorded one.
- [settings-updates-pane](settings-updates-pane.md) — the CLI-availability check reads
  the same `codexCliStatus`/`claudeCliStatus` this pane displays and self-heals.
- [local-dev-orchestration](local-dev-orchestration.md) — unrelated in mechanism, bundled
  in the same development session: the `restart-backend` Tilt resource exists because
  this feature (and the CLI self-heal) needed a way to get a running dev stack onto new
  server code without waiting for every session to go idle.
