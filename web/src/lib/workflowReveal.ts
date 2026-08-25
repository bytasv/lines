/**
 * Scroll a workflow step's start marker into view.
 *
 * The transcript renders a tail window and backfills on idle, so a step's
 * `[data-workflow-step]` marker may not be in the DOM yet when the stepper is
 * clicked. When it isn't, this asks the transcript to drop its window and do the
 * scroll itself once the marker mounts — an event rather than a shared callback so
 * there is no registration lifetime to get wrong.
 */
export const REVEAL_STEP_EVENT = 'lines:reveal-workflow-step';

export function revealWorkflowStep(stepIndex: number): void {
  const marker = document.querySelector(`[data-workflow-step="${stepIndex}"]`);
  if (marker) {
    marker.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  window.dispatchEvent(new CustomEvent<number>(REVEAL_STEP_EVENT, { detail: stepIndex }));
}
