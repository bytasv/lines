import { Box } from '@mantine/core';
import type { ModelProvider } from '@lines/shared';

/** Anthropic's clay, the brand colour the Spark mark ships with. Falls back to the
 *  literal when the design-system variable is absent, which it is here. */
const ANTHROPIC_CLAY = 'var(--cds-clay, #d97757)';

/**
 * The Anthropic and OpenAI marks, as inline SVG.
 *
 * Inline rather than icon-library components because neither brand ships in
 * `@tabler/icons-react`, and inline rather than PNG assets because these render
 * at 10px inside a badge — at that size a raster would blur.
 *
 * The two are drawn differently on purpose. Anthropic's Spark carries its own
 * clay, which is legible on both themes and is how the mark is meant to appear;
 * OpenAI's takes `currentColor`, because its mark is monochrome and has to invert
 * with the theme. Rendering either one in the other's treatment would be wrong
 * rather than merely inconsistent.
 *
 * Used only to disambiguate: a chip shows its mark when more than one provider is
 * connected, and nothing at all when there is only one to be confused with.
 */
export function ProviderMark({ provider, size = 10 }: { provider: ModelProvider; size?: number }) {
  if (provider === 'openai') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden
        style={{ display: 'block' }}
      >
        <path d="M22.28 9.82a5.99 5.99 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6 6 0 0 0 4.98 4.18a5.99 5.99 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07Zm-9.02 12.6a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.79.79 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.06v5.58a4.5 4.5 0 0 1-4.5 4.49ZM3.6 18.3a4.47 4.47 0 0 1-.54-3.01l.14.09 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.07l-4.83 2.79a4.5 4.5 0 0 1-6.14-1.65ZM2.34 7.9a4.49 4.49 0 0 1 2.35-1.98v5.68a.77.77 0 0 0 .38.67l5.82 3.36-2.02 1.17a.08.08 0 0 1-.07 0L3.97 14a4.5 4.5 0 0 1-1.63-6.1Zm16.6 3.86-5.84-3.4L15.1 7.2a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.79.79 0 0 0-.39-.66Zm2.01-3.02-.14-.09-4.77-2.78a.78.78 0 0 0-.79 0L9.42 9.24V6.9a.07.07 0 0 1 .03-.07l4.83-2.78a4.5 4.5 0 0 1 6.68 4.66ZM8.32 12.87 6.3 11.7a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.37-3.45l-.14.08L8.71 5.46a.79.79 0 0 0-.39.68v6.73Zm1.1-2.36 2.6-1.5 2.61 1.5v3l-2.6 1.5-2.61-1.5v-3Z" />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill={ANTHROPIC_CLAY}
      aria-hidden
      style={{ display: 'block' }}
    >
      <path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z" />
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
        // Only the OpenAI mark reads this; Anthropic's carries its own clay.
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
