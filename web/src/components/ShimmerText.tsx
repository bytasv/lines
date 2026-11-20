import { useState, type ReactNode } from 'react';

/** Must match the `lines-text-shimmer` animation's duration in index.css. */
const SHIMMER_PERIOD_MS = 2000;

/**
 * Live status text with the sweeping highlight (`.lines-shimmer-text`), its
 * phase pinned to the wall clock. An element that replaces another — the
 * activity row's "Thinking…" giving way to a step's label, a label changing —
 * picks the sweep up where the old one was instead of restarting it.
 *
 * The delay is taken once, at mount: changing it on a running animation would
 * jump the sweep.
 */
export function ShimmerText({ children }: { children: ReactNode }) {
  const [delay] = useState(() => `-${Date.now() % SHIMMER_PERIOD_MS}ms`);
  return (
    <span className="lines-shimmer-text" style={{ animationDelay: delay }}>
      {children}
    </span>
  );
}
