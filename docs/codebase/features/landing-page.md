# Landing page

## Purpose

The marketing page shown to signed-out visitors at `/` and to anyone at `/welcome`. It sells
Lines as a web GUI for **coding agents** — Claude Code and Codex today, more later — rather than
for one provider. The hero cycles through the supported agent names so a visitor sees both at a
glance.

## Entry points

- `web/src/components/LandingPage.tsx` — the page
- `web/src/components/AgentRotator.tsx` — the animated word in the hero heading

## Important files

- `web/src/index.css` — `.agent-rotator*` classes and the `agent-in` / `agent-out` keyframes, next
  to the other small animations
- `web/src/components/DownloadDesktopApp.tsx` — the install card; names both CLIs
- `web/src/components/PairingDiagram.tsx` — diagram text says "your agent runs here"
- `web/index.html` — `<meta name="description">`

## Important symbols

- `AGENTS` — the provider list (`name`, `setupUrl`) in `LandingPage.tsx`; drives the hero
  rotator, the accessible heading text and the footer install links
- `AgentRotator` — props `words`, `intervalMs`

## Data flow

`AGENTS` is mapped to a list of names, handed to `AgentRotator`, and mapped again to footer
anchors. The rotator keeps the current and previous index in state, advances on an interval, and
marks one word active and one leaving; CSS does the rest.

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

## Related decisions

- [openai-codex-sessions](openai-codex-sessions.md) — why Codex is a supported provider
