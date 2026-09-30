import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

export type RotatorWord = {
  name: string;
  /** The word's gradient, left to right, in the vendor's own palette. */
  gradient: [string, string, string];
};

type Props = {
  words: RotatorWord[];
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
 *
 * Each word is split into letters, so the outgoing one can dissolve letter by
 * letter and the next one form the same way once it is gone. The timings live
 * in index.css; all this supplies is each letter's index and how many letters
 * are leaving, which is what decides when the next word may start.
 */
export function AgentRotator({ words, intervalMs = 2600 }: Props) {
  const [{ index, previous }, setState] = useState<{ index: number; previous: number | null }>({
    index: 0,
    previous: null,
  });
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (words.length < 2 || prefersReducedMotion()) return;
    const id = window.setInterval(() => {
      setState(({ index: current }) => ({ index: (current + 1) % words.length, previous: current }));
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [words.length, intervalMs]);

  // Separate letter boxes would each get a copy of the whole gradient. Knowing
  // the word's width and where each letter starts in it lets every letter paint
  // its own slice of one word-wide gradient instead. Layout positions, so the
  // letters' transforms mid-animation do not disturb them; re-measured when the
  // heading resizes (it steps up a size at the sm breakpoint).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      root.querySelectorAll<HTMLElement>('.agent-rotator-word').forEach((word) => {
        word.style.setProperty('--agent-word-width', `${word.offsetWidth}px`);
        word.querySelectorAll<HTMLElement>('.agent-rotator-letter').forEach((letter) => {
          letter.style.setProperty('--agent-letter-x', `${letter.offsetLeft}px`);
        });
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [words]);

  // The incoming word waits for the last outgoing letter to finish; on first
  // paint nothing is leaving, so it forms straight away.
  const leaving = previous === null ? undefined : words[previous];
  const enterDelay = leaving
    ? `calc(${Array.from(leaving.name).length} * var(--agent-stagger) + var(--agent-out))`
    : '0ms';

  return (
    <span ref={rootRef} className="agent-rotator" aria-hidden="true">
      {words.map((word, i) => (
        <span
          key={word.name}
          className={
            i === index
              ? 'agent-rotator-word is-active'
              : i === previous
                ? 'agent-rotator-word is-leaving'
                : 'agent-rotator-word'
          }
          style={
            {
              '--agent-from': word.gradient[0],
              '--agent-mid': word.gradient[1],
              '--agent-to': word.gradient[2],
              '--agent-enter-delay': i === index ? enterDelay : undefined,
            } as CSSProperties
          }
        >
          {Array.from(word.name).map((letter, j) => (
            <span key={j} className="agent-rotator-letter" style={{ '--i': j } as CSSProperties}>
              {/* A bare space in an inline-block collapses to nothing. */}
              {letter === ' ' ? ' ' : letter}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}
