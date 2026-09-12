# Reasoning-effort selection

Status: **proposed, not built.** Written down while implementing codex plan mode,
where the gap was noticed; deliberately left out of that change to keep it small.

## What is missing

Lines lets a user pick a *model* per session and per workflow step. It does not let
them pick how hard that model thinks. Both providers expose the control and Lines
ignores it on both:

- **Codex** takes `effort: ReasoningEffort` on `turn/start` and `thread/start`
  (`shared/codexProtocol/v2/TurnStartParams.ts`), and carries a separate
  `plan_mode_reasoning_effort` config key — its own TUI runs plan mode at a
  different effort from ordinary turns.
- **Claude** exposes the equivalent through its own model/thinking controls.

So today a "quick rename" turn and a "design the migration" turn cost the same
thinking budget, and the only lever the user has is to switch model entirely —
which is a blunter instrument and, on a session that has already run, refused
outright when it crosses providers.

## Why it is worth doing

Three separate arguments, any one of which would justify it:

1. **Cost and latency.** Effort is the cheapest quality/price dial there is. Users
   who want a fast answer currently have to switch to a smaller model and lose its
   capability along with its price.
2. **Plan mode specifically.** Codex's own product raises effort for planning,
   because a plan is the one output where thinking longer pays for itself most
   directly. Lines' plan mode currently runs at whatever the default is.
3. **Workflows.** This is where it matters most — see below.

## Shape

Three places, in increasing order of value:

### 1. Per session

Beside the model picker in the composer. Same treatment as the model pill: a
current value, a short menu, and it takes effect on the next turn rather than the
running one.

### 2. Per workflow step

The real prize. A workflow is a sequence whose steps have genuinely different
needs — a "read the code and plan" step wants high effort, a "run the formatter and
commit" step wants none. Today every step in a workflow thinks equally hard, so the
user pays planning-grade cost on mechanical steps and gets mechanical-grade thought
on planning steps.

`StepContent` already carries `model` and `permissionMode` per step; effort belongs
in exactly the same place, set in `StepCard.tsx` beside them, and applied by
`WorkflowEngine.runStep` where it already applies the other two.

Unlike model, effort has **no cross-provider problem**: changing it does not strand
a conversation, so it needs none of the fresh-start machinery
`providerSwitchNeedsFreshStart` exists for.

### 3. Per recipe run

Follows for free once a step has it.

## Design notes worth settling before building

- **The vocabularies differ.** Codex's `ReasoningEffort` is its own enum; Claude's
  control is not the same shape. This wants the `shared/providers.ts` treatment —
  ask a capability what efforts a provider offers, rather than hardcoding one
  vendor's list into a picker. A provider that offers none should hide the control,
  the way `linesTools` and `rewind` already gate their UI.
- **"Unset" must stay meaningful.** Every existing session, step and stored
  workflow has no effort recorded, and must keep behaving exactly as it does now —
  the same rule `ModelOption.provider` follows, where absent means the old default.
- **Where it binds.** Codex binds effort per turn, so it can change mid-session;
  confirm the Claude side agrees before promising that in the UI.

## Related

- [model-selector](../codebase/features/model-selector.md) — the picker this sits beside.
- [workflow-step-lifecycle](../codebase/features/workflow-step-lifecycle.md) — where a
  step's model and permission mode are applied, and where effort would join them.
