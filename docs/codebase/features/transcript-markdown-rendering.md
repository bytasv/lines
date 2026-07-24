# Transcript markdown rendering

## Purpose

Renders both user and agent transcript bubbles through the same `Markdown` component, and keeps long unbroken content (diffs, paths) inside the conversation column instead of overflowing it.

## Entry points

- `web/src/components/Transcript.tsx` (`Item`, `case 'user'`)

## Important files

- `web/src/components/Transcript.tsx` — user bubble renders `<Markdown text={item.text} />`
- `web/src/components/Markdown.tsx` — shared renderer (`rehypeColorSwatches`, `rehypeFilePaths`, `rehypeHighlight`)
- `web/src/index.css` — `.md-body pre code` wrap rules

## Important symbols

- `Markdown` — shared renderer, now used by both user and agent bubbles
- `.md-body pre code` — CSS controlling code-block overflow behavior

## Data flow

`TranscriptItem` (user, `item.text`) → `Markdown` → `ReactMarkdown` + rehype plugins (syntax highlight, file-path links, color swatches) → rendered inside the user `Paper` bubble.

## Dependencies

None beyond the existing `Markdown` component and its rehype plugin chain.

## Tests

None. No test infrastructure covers `Transcript`/`Markdown` rendering at time of writing.

## Business rules

- User bubbles render markdown (headings, code fences, lists, color swatches) instead of plain preformatted text; single newlines collapse and raw HTML tags are dropped, matching agent-side behavior.
- Code blocks (`.md-body pre code`) wrap long lines (`white-space: pre-wrap`, `overflow-wrap: anywhere`) instead of scrolling horizontally, so they stay within the conversation column.

## Architectural rules

- User and agent transcript bubbles share one markdown renderer (`Markdown`) rather than each having their own text-rendering path; `ColorizedText.tsx` (the prior plain-text-plus-swatch twin) was deleted as dead code.
- The user bubble `Paper` needs `minWidth: 0` alongside `flex: 1` — without it, a flex child containing wide content (e.g. a code block) can grow past the column width regardless of the CSS wrap rules on its content.

## Related decisions

None recorded.
