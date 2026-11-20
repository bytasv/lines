import { useState, type ReactNode } from 'react';

/**
 * One line of text that crossfades when its content changes: the old line fades
 * out on top of the new one fading in, both in the same grid cell, so there is
 * never an empty frame and nothing around it moves. Each layer truncates with
 * its own ellipsis.
 *
 * `value` is data, not nodes: the outgoing layer renders the value the line had
 * just before the change, the current one the live value. `same` says when a
 * change is too small to fade (a ticking counter) and only updates in place.
 * `from` starts the line mid-swap, fading out what another element showed just
 * before this one replaced it.
 */
export function CrossfadeLine<T>({
  value,
  same,
  render,
  tone,
  from,
}: {
  value: T;
  same: (a: T, b: T) => boolean;
  /** `current` is false for the outgoing layer. */
  render: (value: T, current: boolean) => ReactNode;
  /** The layer's text colour; its ellipsis takes it too. */
  tone?: (value: T) => string | undefined;
  from?: T | null;
}) {
  // `faded`: the current layer arrived by a change, so it animates in. Kept for
  // the layer's lifetime (it is keyed by `n`): dropping the class when the old
  // layer finishes would cut the new layer's own fade short.
  const [s, setS] = useState<{ cur: T; prev: T | null; n: number; faded: boolean }>(() => ({
    cur: value,
    prev: from ?? null,
    n: 0,
    faded: from != null,
  }));
  // Adjusting state while rendering (React re-runs this component at once). A
  // small change is still recorded, so a later fade-out shows the latest text.
  if (s.cur !== value) {
    if (same(s.cur, value)) setS({ ...s, cur: value });
    else setS({ cur: value, prev: s.cur, n: s.n + 1, faded: true });
  }
  const { prev, n, faded } = s;
  return (
    <div className="tx-xfade">
      {prev !== null && (
        <div
          key={`out${n}`}
          className="tx-xfade-layer tx-text-out"
          style={{ color: tone?.(prev) }}
          aria-hidden
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) setS((x) => (x.n === n ? { ...x, prev: null } : x));
          }}
        >
          {render(prev, false)}
        </div>
      )}
      <div
        key={`in${n}`}
        className={faded ? 'tx-xfade-layer tx-text-in' : 'tx-xfade-layer'}
        style={{ color: tone?.(value) }}
      >
        {render(value, true)}
      </div>
    </div>
  );
}
