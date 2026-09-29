import { useEffect, useState } from 'react';

type Props = {
  words: string[];
  intervalMs?: number;
};

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Cycles through `words` on a line of its own. Every word is stacked in one
 * grid cell and centred independently, so the line never changes height and a
 * short word leaves no gap. Decorative only: the caller owns the accessible
 * text, so this is aria-hidden.
 */
export function AgentRotator({ words, intervalMs = 1800 }: Props) {
  const [{ index, previous }, setState] = useState<{ index: number; previous: number | null }>({
    index: 0,
    previous: null,
  });

  useEffect(() => {
    if (words.length < 2 || prefersReducedMotion()) return;
    const id = window.setInterval(() => {
      setState(({ index: current }) => ({ index: (current + 1) % words.length, previous: current }));
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [words.length, intervalMs]);

  return (
    <span className="agent-rotator" aria-hidden="true">
      {words.map((word, i) => (
        <span
          key={word}
          className={
            i === index
              ? 'agent-rotator-word is-active'
              : i === previous
                ? 'agent-rotator-word is-leaving'
                : 'agent-rotator-word'
          }
        >
          {word}
        </span>
      ))}
    </span>
  );
}
