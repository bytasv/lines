# Transcript markdown rendering

## Purpose

Renders every transcript item's text through the same `Markdown` component with a shared compact rhythm. A bubble is reserved for user prompts only — agent output (answers, tool summaries) renders unwrapped, flush-left, borderless.

## Entry points

- `web/src/components/Transcript.tsx` (`Item`, `case 'user'` and `case 'assistant'`)

## Important files

- `web/src/components/Transcript.tsx` — user bubble renders `<Markdown text={item.text} />`; agent text (`case 'assistant'`, streaming) renders the same component with no wrapping `Paper`
- `web/src/components/Markdown.tsx` — shared renderer (`rehypeColorSwatches`, `rehypeFilePaths`, `rehypeHighlight`)
- `web/src/index.css` — `.md-body` compact spacing vars, `.md-body pre code` wrap rules, `.tx-row`/`.tx-streaming` borderless-row and caret styling

## Important symbols

- `Markdown` — shared renderer, used by both the user bubble and unwrapped agent text
- `.md-body` — CSS scope overriding Mantine `Typography` spacing/heading vars for a compact rhythm
- `.md-body pre code` — CSS controlling code-block overflow behavior
- `.tx-row` / `.tx-streaming` — borderless hover row and streaming-caret classes shared by the transcript's collapsible rows (see the borderless-row system below)

## Data flow

`TranscriptItem` (`user.text` or `assistant.blocks[].text`) → `Markdown` → `ReactMarkdown` + rehype plugins (syntax highlight, file-path links, color swatches) → rendered inside the user `Paper` bubble, or directly (no wrapper) for agent text.

## Dependencies

None beyond the existing `Markdown` component and its rehype plugin chain.

## Tests

None. No test infrastructure covers `Transcript`/`Markdown` rendering at time of writing.

## Business rules

- User and agent text render markdown (headings, code fences, lists, color swatches) instead of plain preformatted text; single newlines collapse and raw HTML tags are dropped.
- Code blocks (`.md-body pre code`) wrap long lines (`white-space: pre-wrap`, `overflow-wrap: anywhere`) instead of scrolling horizontally, so they stay within the conversation column.
- Only the user prompt renders as a bubble (right-aligned `Paper`, capped at 80% column width). Agent output — answers, folded turns, tool groups/calls — is unwrapped and flush-left; nesting is shown by vertical order and the row's expand/collapse affordance, not by a box or indentation.

## Architectural rules

- User and agent transcript text share one markdown renderer (`Markdown`) rather than each having its own text-rendering path; `ColorizedText.tsx` (the prior plain-text-plus-swatch twin) was deleted as dead code.
- The user bubble `Paper` needs `minWidth: 0` alongside `maxWidth: '80%'` — without it, a flex child containing wide content (e.g. a code block or one long unbroken token) can grow past 80% regardless of the CSS wrap rules on its content: used width is `max(min-width, min(max-width, width))`, so a default `min-width: auto` (min-content) would win over `maxWidth` for a single unbreakable run.
- Compact markdown rhythm is implemented as **scoped Mantine spacing variable overrides on `.md-body`**, not CSS selector overrides. Mantine `Typography`'s list rule is `:where(ul, ol):not([data-type='taskList'])`, specificity (0,2,0), which beats a `.md-body ul` override at (0,1,1) regardless of import order — only overriding the underlying `--mantine-spacing-*`/`--mantine-h*-font-size` vars sidesteps that.
- Collapsible transcript rows (agent turns, tool groups, tool calls) share one borderless row convention (`.tx-row` in `web/src/index.css`): no `Paper`/border, hover highlight via CSS, click/keyboard toggle on the row `Group`, no accumulating indentation — every row (top-level or nested inside an expanded body) sits at the same left edge. A `Task` card's subagent transcript is a third nesting level under the same convention — no indentation, only the expand/collapse affordance — see [[subagent-transcript]].
- A collapsed row's body (markdown, tool input/result, nested diff computation) is not rendered while closed — `Collapse`'s `expanded` prop only hides it visually, so the body's own children are additionally gated on `expanded` so they unmount instead of merely being hidden. Most rows in a long transcript load collapsed, so this is what keeps first paint cheap. Consequence: any state living inside a collapsed body (e.g. a tool card's own expand toggle) does not survive its parent collapsing/expanding unless lifted into a module-scope sticky map — see the `stickyOverrides`/`turnOverrides`/`stickyExpanded` maps in `ToolGroup.tsx`, `Transcript.tsx`, and `ToolCallCard.tsx`.
- No virtualization (`react-window` or similar) is used for the transcript list — this was a deliberate choice before lazy-mounted bodies existed, and it still holds afterward: once a collapsed row's body costs nothing to render, the remaining per-row cost (a header line) is cheap enough at the transcript sizes seen in practice that windowing isn't needed.

## Related decisions

None recorded.
