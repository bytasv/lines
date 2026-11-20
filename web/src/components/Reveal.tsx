import { useState, type AnimationEvent, type ReactNode } from 'react';

/**
 * Grows its content in (height and opacity together) when `on` at mount, pushing what
 * is below down smoothly instead of all at once. Inert once the animation ends:
 * the clipping it needs while growing is dropped, so nothing inside is cut off
 * later. The wrapper pair is always rendered, so ending the animation never
 * remounts the children.
 */
export function Reveal({ on, children }: { on: boolean; children: ReactNode }) {
  const [revealing, setRevealing] = useState(on);
  const end = (e: AnimationEvent) => {
    // Descendants' animations (an icon crossfade) bubble up here too.
    if (e.target === e.currentTarget) setRevealing(false);
  };
  return (
    <div className={revealing ? 'tx-reveal' : undefined} onAnimationEnd={revealing ? end : undefined}>
      <div className="tx-reveal-inner">{children}</div>
    </div>
  );
}
