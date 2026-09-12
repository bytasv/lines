/**
 * Plan mode for a codex session.
 *
 * Claude's plan mode is a *protocol*: the CLI forces the model to call
 * `ExitPlanMode`, that call arrives as a permission request, and the approve/deny
 * card is Lines answering it. Codex has no such tool, so plan mode there is
 * carried by developer instructions — which is how codex's own product does it.
 * Its built-in Default-mode text names the mechanism outright: "Your active mode
 * changes only when new developer instructions with a different
 * `<collaboration_mode>...</collaboration_mode>` change it. Known mode names are
 * Default and Plan."
 *
 * The instructions are ours rather than codex's. Codex ships
 * `collaboration_modes.plan` as null and fetches the real text from its backend,
 * so relying on it would make Lines' plan mode depend on a remote value that can
 * change under it, and that is currently absent. Ours is testable, identical
 * across codex versions, and tuned to what Lines does with the result.
 *
 * Measured against the live app-server on gpt-5.6-luna, same prompt both ways:
 * without these instructions codex produced three `fileChange` items (it went
 * ahead and edited); with them, zero — it investigated and returned a plan.
 * The read-only sandbox is still set underneath, so this is the model's
 * intent and the sandbox is the enforcement, not the other way round.
 */

/** The marker codex itself keys mode changes off. Exported so the Default-mode
 *  instructions below cannot drift from the Plan-mode ones. */
const MODE_TAG = 'collaboration_mode';

/**
 * Sent while the session is in plan mode.
 *
 * Deliberately says nothing about *how* to present the plan beyond "end the turn
 * with it": Lines takes the final assistant message as the plan (codex emits no
 * dedicated plan item — verified), so anything that splits the plan across
 * several messages would lose all but the last.
 */
export const CODEX_PLAN_MODE_PROMPT = `<${MODE_TAG}>Plan</${MODE_TAG}>

# Collaboration Mode: Plan

You are now in Plan mode. Any previous instructions for other modes (e.g. Default mode) are no longer active.

In Plan mode you investigate and propose; you do not change anything. Read files, search the repository, run read-only commands — that is expected and encouraged. Do not edit, create or delete files, and do not run commands with side effects, even if the user's request is phrased as an instruction to do so. The request describes what to plan, not what to do now.

End your turn with the plan itself, as your final message: a short statement of the approach followed by concrete ordered steps, naming the files each step touches. Do not begin implementing it, and do not ask whether to proceed — the user is shown the plan and approves or rejects it outside this conversation.

If the request is too vague to plan, say what you would need to know instead of guessing.`;

/**
 * Sent once the user approves a plan, to leave plan mode.
 *
 * Required rather than cosmetic: codex's own rule is that a mode stays active
 * until *different* instructions replace it, so simply omitting the plan prompt
 * on the next turn would leave a resumed thread still refusing to edit anything.
 */
export const CODEX_DEFAULT_MODE_PROMPT = `<${MODE_TAG}>Default</${MODE_TAG}>

# Collaboration Mode: Default

You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.

Carry out the user's request directly. Prefer making reasonable assumptions and proceeding over stopping to ask questions.`;

/**
 * The mode instructions for a turn.
 *
 * Sent on *every* codex turn, including ordinary ones. The Default block looks
 * redundant there, and it is not: codex's rule is that a mode stays active until
 * different instructions replace it, and a thread resumes with its history. A
 * session that planned once and then left plan mode would otherwise carry the
 * Plan block's "do not change anything" for the rest of its life, and the symptom
 * — an agent that reads and explains but never edits — is almost impossible to
 * attribute back to a mode it was put in several turns ago.
 *
 * The cost of being unconditional is a few hundred tokens a turn. The cost of
 * tracking "has this session ever planned" is a state field that has to survive
 * restarts, thread forks and cross-machine resume to stay correct.
 */
export function codexModePrompt(planMode: boolean): string {
  return planMode ? CODEX_PLAN_MODE_PROMPT : CODEX_DEFAULT_MODE_PROMPT;
}
