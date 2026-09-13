/**
 * Plan mode for a codex session.
 *
 * Claude's plan mode is a protocol: the CLI forces the model to call
 * `ExitPlanMode`, and Lines answering that request is the approve/deny card.
 * Codex's is a **collaboration mode** — a first-class preset it enters itself,
 * selected per turn.
 *
 * An earlier cut of this file hand-wrote a `<collaboration_mode>Plan</...>` block
 * and passed it as `developerInstructions`, on the theory that codex's own rule
 * ("your mode changes when developer instructions with a different tag arrive")
 * applied to any client text. It does not — that rule governs codex's *managed*
 * instructions. Measured, the difference is everything:
 *
 *                                   questions  fileChanges  plan items
 *   hand-written tag                        0            0           0
 *   collaborationMode: {mode:'plan'}        2            0           1
 *
 * The fabricated mode produced prose that merely avoided editing. The real one
 * asks clarifying questions through `request_user_input`, stays read-only, and
 * emits a real `plan` item — because the tool grant and the plan contract live
 * inside codex's managed Plan instructions, which only exist in the real mode.
 *
 * Both the field and `collaborationMode/list` are experimental-API-only, so they
 * are absent from `shared/codexProtocol` (generated without that capability) and
 * unreachable until `codexAppServer.ts` declares `experimentalApi: true`.
 */

/** Codex's `ModeKind`. Its `collaborationMode/list` reports exactly these two. */
export type CodexModeKind = 'plan' | 'default';

/**
 * One collaboration mode as `turn/start` takes it.
 *
 * `settings.model` is a **required string** — codex rejects null with "invalid
 * type: null, expected a string", which is how the field was found at all.
 *
 * `reasoning_effort` must be sent too, and that is not obvious: a null there is
 * taken literally rather than as "use the preset's". Measured, sending null
 * turned plan mode off in all but name — 0 questions, 0 plan items, the same
 * nothing the hand-written prompt produced, while `'medium'` gave 2 and 1. The
 * worker fills it from `collaborationMode/list` so the value stays OpenAI's
 * rather than ours; see `applyModePreset` in workerCodex.ts.
 */
export interface CodexCollaborationMode {
  mode: CodexModeKind;
  settings: {
    model: string;
    reasoning_effort: string | null;
    developer_instructions: string | null;
  };
}

/**
 * The collaboration mode a turn runs in.
 *
 * Sent on every turn, not only plan ones. Codex's mode persists until a
 * different one replaces it and a resumed thread carries its history, so a
 * session that planned once and then left plan mode would otherwise keep
 * refusing to edit — a symptom nearly impossible to trace back to a mode set
 * several turns earlier.
 *
 * `reasoning_effort` is left null *here* and filled in the worker, which is the
 * side that can ask codex what the preset actually is. A turn must not reach
 * `turn/start` still carrying null — see the note above.
 */
export function codexCollaborationMode(
  planMode: boolean,
  model: string,
): CodexCollaborationMode {
  return {
    mode: planMode ? 'plan' : 'default',
    settings: { model, reasoning_effort: null, developer_instructions: null },
  };
}

/** What Plan runs at when codex cannot be asked. Its own `collaborationMode/list`
 *  reports this; used only if that call fails. */
export const CODEX_PLAN_FALLBACK_EFFORT = 'medium';
