import { useState } from 'react';

/**
 * A number that goes up each time `value` changes after the first render.
 *
 * Used as the `key` of an element whose CSS enter animation should replay on a
 * real change (a step's status flips, a label is replaced), and never on mount:
 * a reload or a scroll back must not set every row in the transcript moving.
 * `n > 0` doubles as "this element is here because something changed".
 */
export function useChangeKey(value: string | number | boolean | null | undefined): number {
  const [seen, setSeen] = useState({ value, n: 0 });
  if (!Object.is(seen.value, value)) {
    // Adjusting state while rendering, the React-sanctioned way: React re-runs
    // this component straight away, before anything is committed.
    const next = { value, n: seen.n + 1 };
    setSeen(next);
    return next.n;
  }
  return seen.n;
}
