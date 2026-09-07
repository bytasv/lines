/**
 * Ask the transcript to scroll a workflow step's start marker into view.
 *
 * The transcript owns both paths, because both have to unpin follow-the-stream
 * or a live turn's autoscroll drags the view straight back to the bottom: it
 * scrolls to the `[data-workflow-step]` marker when that marker is already
 * mounted in its own viewport, and otherwise drops its tail window and scrolls
 * once the marker mounts. An event rather than a shared callback so there is no
 * registration lifetime to get wrong.
 */
export const REVEAL_STEP_EVENT = 'lines:reveal-workflow-step';

export function revealWorkflowStep(stepIndex: number): void {
  window.dispatchEvent(new CustomEvent<number>(REVEAL_STEP_EVENT, { detail: stepIndex }));
}
