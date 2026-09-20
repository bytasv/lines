/**
 * Which workflow steps get to show their name.
 *
 * The stepper gave every step an equal share of one row. That is right for the
 * three- and four-step workflows it was built against and wrong the moment there
 * are eight: each column collapses to a few dozen pixels and every name truncates
 * to an ellipsis, so a row that exists to say *where you are* stops saying
 * anything at all. On a phone it happens at three.
 *
 * So names are budgeted. A window of steps around the current one keeps its name,
 * metrics and progress track; the rest keep their numbered icon — which is what
 * carries "four done, this one running, three to go" — and nothing else.
 *
 * Pure, and free of imports, so it can be unit-tested from the server's
 * `node:test` runner (the same arrangement as `lib/pointer.ts`).
 */

/** Inclusive `[start, end]` range of steps that may show their name. */
export function namedStepWindow(
  count: number,
  active: number,
  budget: number,
): { start: number; end: number } {
  if (count <= 0) return { start: 0, end: -1 };
  if (budget >= count) return { start: 0, end: count - 1 };
  const room = Math.max(1, budget);
  // Clamp first: an out-of-range index is a step that was deleted from under a
  // running session, and a window computed from it would be empty rather than
  // merely misplaced.
  const at = Math.min(Math.max(active, 0), count - 1);
  const before = Math.floor((room - 1) / 2);
  // Slide rather than shrink at the ends: the window keeps its full budget when
  // the current step is first or last, which is where a workflow spends most of
  // its life.
  const start = Math.min(Math.max(at - before, 0), count - room);
  return { start, end: start + room - 1 };
}
