import { Box } from '@mantine/core';
import type { ModelProvider } from '@lines/shared';

/**
 * The Anthropic and OpenAI marks, as inline SVG.
 *
 * Inline rather than icon-library components because neither brand ships in
 * `@tabler/icons-react`, and inline rather than PNG assets because these render
 * at 10px inside a badge — at that size a raster would blur, and `currentColor`
 * lets one path serve both themes.
 *
 * Used only to disambiguate: a chip shows its mark when more than one provider is
 * connected, and nothing at all when there is only one to be confused with.
 */
export function ProviderMark({ provider, size = 10 }: { provider: ModelProvider; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    'aria-hidden': true,
    style: { display: 'block' },
  } as const;

  if (provider === 'openai') {
    return (
      <svg {...common}>
        <path d="M22.28 9.82a5.99 5.99 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6 6 0 0 0 4.98 4.18a5.99 5.99 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07Zm-9.02 12.6a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.79.79 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.06v5.58a4.5 4.5 0 0 1-4.5 4.49ZM3.6 18.3a4.47 4.47 0 0 1-.54-3.01l.14.09 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.07l-4.83 2.79a4.5 4.5 0 0 1-6.14-1.65ZM2.34 7.9a4.49 4.49 0 0 1 2.35-1.98v5.68a.77.77 0 0 0 .38.67l5.82 3.36-2.02 1.17a.08.08 0 0 1-.07 0L3.97 14a4.5 4.5 0 0 1-1.63-6.1Zm16.6 3.86-5.84-3.4L15.1 7.2a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.79.79 0 0 0-.39-.66Zm2.01-3.02-.14-.09-4.77-2.78a.78.78 0 0 0-.79 0L9.42 9.24V6.9a.07.07 0 0 1 .03-.07l4.83-2.78a4.5 4.5 0 0 1 6.68 4.66ZM8.32 12.87 6.3 11.7a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.37-3.45l-.14.08L8.71 5.46a.79.79 0 0 0-.39.68v6.73Zm1.1-2.36 2.6-1.5 2.61 1.5v3l-2.6 1.5-2.61-1.5v-3Z" />
      </svg>
    );
  }
  // Anthropic's mark: the two strokes of the "A".
  return (
    <svg {...common}>
      <path d="M13.83 4h-3.2L4.5 20h3.3l1.25-3.4h6.4L16.7 20H20L13.83 4Zm-3.9 9.9 2.1-5.7 2.1 5.7h-4.2Z" />
    </svg>
  );
}

/**
 * The mark, plated, for the bottom-right corner of a usage ring. Absolutely
 * positioned, so it overlaps the ring's own bounding box rather than widening it
 * — the two chips must stay the same size whether or not the badge is shown.
 */
export function ProviderBadge({ provider }: { provider: ModelProvider }) {
  return (
    <Box
      style={{
        position: 'absolute',
        right: -1,
        bottom: -1,
        display: 'flex',
        padding: 2,
        borderRadius: '50%',
        color: 'var(--mantine-color-text)',
        background: 'var(--mantine-color-body)',
        // The ring passes underneath, so the plate needs an edge of its own to
        // read as a badge rather than as a hole punched in the ring.
        boxShadow: '0 0 0 1px var(--mantine-color-default-border)',
      }}
    >
      <ProviderMark provider={provider} />
    </Box>
  );
}
