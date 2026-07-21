import { memo, type ReactNode } from 'react';
import { findColorLiterals } from '../lib/colorLiterals';
import { InlineColorSwatch } from './InlineColorSwatch';

// Plain-text counterpart of rehypeColorSwatches: appends an inline swatch
// after each color literal. Text slices are kept verbatim so the parent's
// whiteSpace: 'pre-wrap' still applies.
export const ColorizedText = memo(function ColorizedText({ text }: { text: string }) {
  const matches = findColorLiterals(text);
  if (matches.length === 0) return text;

  const out: ReactNode[] = [];
  let last = 0;
  for (const m of matches) {
    out.push(text.slice(last, m.end));
    out.push(<InlineColorSwatch key={m.start} color={m.value} />);
    last = m.end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
});
