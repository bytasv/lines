# Landing page

## Purpose

The marketing page shown to signed-out visitors at `/` and to anyone at `/welcome`. It sells
Lines as a web GUI for **coding agents** — Claude Code and Codex today, more later — rather than
for one provider. The hero cycles through the supported agent names so a visitor sees both at a
glance. Below the hero the page walks through how it works, the feature groups, security, the ways
to run it and getting started, each with an illustrated card. The app itself is monochrome (see
Architectural rules), and the page follows it.

## Entry points

- `web/src/components/LandingPage.tsx` — the page
- `web/src/components/AgentRotator.tsx` — the animated word in the hero heading
- `web/src/components/landing/` — the inline-SVG illustrations, one file per section (steps,
  features, security, ways to run) plus a shared kit and its CSS

## Important files

- `web/src/components/LandingPage.module.css` — page chrome: sticky header, hero backdrop, bento
  grid, illustrated-card layout, scroll reveal, smooth-scroll rule
- `web/src/index.css` — `.agent-rotator*` classes and the letter in/out and gradient-drift
  keyframes, next to the other small animations
- `web/src/theme.ts` — the app-wide monochrome theme the page inherits
- `web/src/components/ProviderMark.tsx` — exports the Anthropic clay colour the hero gradient uses
- `web/src/components/DownloadDesktopApp.tsx` — the install card; names both CLIs
- `web/src/components/PairingDiagram.tsx` — diagram text says "your agent runs here"
- `web/index.html` — `<meta name="description">`

## Important symbols

- `AGENTS` — the provider list (`name`, `gradient`, `setupUrl`) in `LandingPage.tsx`; drives the
  hero rotator, the accessible heading text and the footer install links
- `AgentRotator` — props `words` (`name` plus a three-colour `gradient`), `intervalMs`

## Data flow

`AGENTS` is mapped to a list of names, handed to `AgentRotator`, and mapped again to footer
anchors. The rotator keeps the current and previous index in state, advances on an interval, and
marks one word active and one leaving; CSS does the rest. Each word is split into letters so the
outgoing word dissolves letter by letter and the next forms the same way once it is gone; the
rotator measures the word width and each letter's offset so every letter paints its slice of one
word-wide gradient in the vendor's palette, which drifts slowly.

Section content (feature groups, security cards, ways to run, how-it-works steps) is static data in
`LandingPage.tsx`, each entry paired with a drawing from `landing/`.

## Dependencies

Mantine (`VisuallyHidden`, layout), Clerk signed-in/out components for the header action.

## Tests

None; the page is presentational.

## Business rules

- Generic claims say "coding agent" or list providers; strings that are truly provider-specific
  (Claude CLI status, Claude sign-in, SDK internals) stay provider-specific.
- Supporting another provider in the copy is one new `AGENTS` entry. The list is local to the page
  on purpose: `shared/providers.ts` is capability data, not marketing copy.
- The install card says at least one of Claude Code or Codex must be installed on the paired
  machine.

## Architectural rules

- The rotating word sits on its own line with every word stacked in one grid cell and centred
  independently. A short word ("Codex") therefore leaves no gap, and a long one never re-wraps the
  heading, whatever the viewport. Placing it mid-sentence was tried and rejected: the text around
  it shifts on each swap.
- The visible heading is `aria-hidden`; a `VisuallyHidden` sibling carries the full sentence
  naming every agent, so assistive tech never hears the words cycle.
- With `prefers-reduced-motion: reduce` the rotator renders the first word and starts no timer,
  and the CSS disables the animation as a second guard. The interval is cleared on unmount.
- The hero words use only their vendor's brand colours, as gradients; no sparkles or extra hues.
- The illustrations are decorative and `aria-hidden`; the card text carries the meaning. They use
  Mantine colour variables so they follow the colour scheme, and status hues only where a drawing
  shows a status.
- The header links are plain `#anchors`; smooth scrolling is scoped to the mounted page and is off
  under reduced motion.
- Encryption copy states that end-to-end encryption is on by default: every browser enrols once
  with a code from the machine, and its traffic is carried by the relay but cannot be read or
  forged. It never claims everything is encrypted or zero-knowledge.
- The app-wide theme is black, white and gray (`mono` primary as a light/dark virtual colour, a
  softened neutral dark scheme). Status colours keep their hues but are muted: `theme.ts` re-ramps
  Mantine's hues on one shared OKLCH lightness curve at lower chroma, with teal and cyan spread
  apart so done, needs answer and needs approval stay distinct, and gray loses its blue tint. In the
  dark scheme `index.css` re-points `light`-variant badges to a translucent tint with text in the
  hue. The old sandstone and slate palettes are gone, and "needs approval" now uses cyan.

## Related decisions

- [openai-codex-sessions](openai-codex-sessions.md) — why Codex is a supported provider
