# Landing page

## Purpose

The marketing page: shown to signed-out visitors at `/` and to anyone at `/welcome` inside the
app, and served on its own as a static, keyless build on the apex of a hosted deployment. It sells
Lines as a web GUI for **coding agents** — Claude Code and Codex today, more later — rather than
for one provider. The hero cycles through the supported agent names so a visitor sees both at a
glance. The hero's first action is the Mac download, beside Get started, with the facts a visitor
checks before installing (Apple silicon, notarized by Apple); under it sit the open-source line, a
GitHub star link and a self-hosted demo loop. Below that the page walks through how it works, the
feature groups, security, where your data goes, the ways to run it and getting started, most with an
illustrated card. Getting started closes on two panels: the Mac app and the account. The app itself is monochrome (see
Architectural rules), and the page follows it.

## Entry points

- `web/src/components/LandingPage.tsx` — the page
- `web/src/landing.tsx`, `web/landing/index.html`, `web/vite.landing.config.ts` — the standalone
  marketing build (`npm run build:landing -w web`, output `web/dist-landing`)
- `web/src/components/AgentRotator.tsx` — the animated word in the hero heading
- `web/src/components/landing/` — the inline-SVG illustrations, one file per section (steps,
  features, security, ways to run) plus a shared kit and its CSS
- `PRIVACY.md` (repo root) — the full data inventory the "Where your data goes" section summarises

## Important files

- `web/src/components/LandingPage.module.css` — page chrome: sticky header, hero backdrop, bento
  grid, illustrated-card layout, scroll reveal, smooth-scroll rule
- `web/src/index.css` — `.agent-rotator*` classes and the letter in/out and gradient-drift
  keyframes, next to the other small animations
- `web/src/theme.ts` — the app-wide monochrome theme the page inherits
- `web/src/components/ProviderMark.tsx` — exports the Anthropic clay colour the hero gradient uses
- `web/src/lib/storage.ts` — `DESKTOP_DOWNLOAD_URL`, `_ENABLED`, `_VERSION` and `_HREF`, the
  build-time download link every download button reads. `DownloadDesktopApp.tsx` is the in-app
  install card (connect gate, Settings → Devices) and is not used here
- `web/public/icon-192.png` — the app icon shown on the Mac panel, same art as the DMG's
- `web/src/components/PairingDiagram.tsx` — diagram text says "your agent runs here"
- `web/index.html`, `web/landing/index.html` — `<title>`, `<meta name="description">` and the
  Open Graph / Twitter card tags (both pages carry the same set); `web/index.html` also holds the
  inline check that skips the boot splash for landing routes and signed-out visitors
- `web/public/og.png` (1200×630 share image) and `web/public/demo.mp4` (hero loop) — static
  assets, served same-origin from both builds' `publicDir`
- `deploy/docker/web-nginx.conf` — the `/download` 302 every download button links to
- `web/src/lib/splash.ts` — `splashSkippedAtBoot`, read by the root route

## Important symbols

- `AGENTS` — the provider list (`name`, `gradient`, `setupUrl`) in `LandingPage.tsx`; drives the
  hero rotator, the accessible heading text and the footer install links
- `AgentRotator` — props `words` (`name` plus a three-colour `gradient`), `intervalMs`
- `DATA_FLOWS` — the four "Where your data goes" rows in `LandingPage.tsx`
- `DemoVideo` — the hero loop; `DEMO_VIDEO` and `DEMO_POSTER` name its files
- `DESKTOP_DOWNLOAD_HREF` — in `lib/storage.ts`: `/download` in production builds, the DMG URL in
  dev
- `HeroActions`, `DownloadMacButton`, `DownloadFacts`, `GetStartedPanels` — the download-first
  hero actions, the shared Mac button, its facts line, and the closing Mac and account panels

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

Mantine (`VisuallyHidden`, layout), Clerk signed-in/out components for the header action (in-app
only). The standalone build also uses `subresourceIntegrity` exported from `web/vite.config.ts`.

## Tests

None; the page is presentational.

## Business rules

- The landing page paints immediately, never behind the boot splash. While Clerk is still loading
  for a visitor judged a guest, the root route renders it directly, at the tree position it keeps
  once Clerk reports signed out, so it does not remount.
- Generic claims say "coding agent" or list providers; strings that are truly provider-specific
  (Claude CLI status, Claude sign-in, SDK internals) stay provider-specific.
- Supporting another provider in the copy is one new `AGENTS` entry. The list is local to the page
  on purpose: `shared/providers.ts` is capability data, not marketing copy.
- The closing panels' footnotes say at least one of Claude Code or Codex must be installed on the
  paired machine, and point Windows and Linux users at running from source.
- Download first: the hero leads with the Mac download, then Get started; Sign in lives in the
  header. With no build published the hero falls back to Get started and Sign in, and the account
  panel spans the closing row alone.
- "Notarized by Apple" is true only from desktop 0.2.43, so the configured download link must serve
  the stable `Lines-latest.dmg` alias (or a signed versioned build). The version shows only when
  the link names one; the alias does not.
- Privacy copy uses only these lines, or wording that says no more than they do:
  - "The agent runs on your machine, with your files, git and CLI login. Nothing is executed in
    the cloud."
  - "Your repos and full transcripts live on your machine and are never stored on Lines
    servers." A claim about storage, not transit: the conversation and the code the agent reads
    go to the model provider, live views cross the relay, and summaries, workflow outputs and
    queued prompts (which can quote code) sit in storage, as `PRIVACY.md` says.
  - "Live traffic between your devices and your machine is end-to-end encrypted." Keep "your
    devices": guests invited into a session are not end-to-end encrypted yet.
  - "Session list, workflows and memory sync to Lines storage so every device sees them.
    Self-host it if you'd rather own that too."
  - "Prompts go to Anthropic or OpenAI under your own account, same as using the CLI directly."
- Banned anywhere: "your code never leaves your machine" and "transcripts and files never leave
  your machine" (prompts carry code to the provider, and live views cross the relay),
  "zero-knowledge", "we can't see anything". Storage holds session metadata, queued prompts,
  compaction summaries and workflow outputs in plaintext, and the relay sees connection metadata;
  any new claim has to survive `PRIVACY.md`.
- "Where your data goes" mirrors `PRIVACY.md`'s headings and links to it on GitHub. A change to
  what is stored or relayed changes both in the same commit.
- Shared links carry `?ref=<channel>`; that query string in the nginx access log is the only
  channel attribution (see [production-deployment](production-deployment.md) and
  `deploy/README.md`, Growth metrics).
- Copy says "works with Claude Code and Codex", never anything implying a partnership with or
  endorsement by Anthropic or OpenAI.

## Architectural rules

- `LandingPage` takes an optional `appUrl`. Set (only by `landing.tsx`, from `VITE_APP_URL`), the
  header action and both call-to-action pairs are plain links to `<appUrl>/sign-in`, replacing the
  Clerk and router components; unset, the in-app behaviour is unchanged. The standalone entry
  mounts only Mantine and the page, so the apex never loads Clerk or any key (see
  [production-deployment](production-deployment.md#origin-separation)). The app host's
  `/sign-in` route is where those links land; local and dev builds have no apex, so signed-out
  `/` there still renders the page.
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
- The header is a three-column grid with the action pinned to column 3, so the nav does not move
  while Clerk resolves the signed-in/out action. That column also holds a GitHub icon link beside
  the action, in both builds. It is a plain link: a star-count badge would mean a request to
  GitHub's API from the origin that holds the encryption keys.
- The header's Download button shows from `md` up only: below that the nav and three actions crowd
  the row, and a phone cannot install it anyway. The hero carries the download at every width.
- The download is the one lit button: a soft glow drawn in the text colour, so it inverts with the
  scheme. Calls to action stack full width on a phone and form one centred row from `xs`.
- No analytics or tracking script, and no third-party embed (YouTube and similar), on either
  build. The app's origin holds the end-to-end encryption keys, so any third-party script there
  is code next to them, and it would break the enforcing CSP. Measurement is server-side only: the
  access log and the `/download` redirect. Richer analytics would need a marketing site on an
  origin of its own.
- The download button links to `/download`, which the serving nginx (web or landing) 302s to
  `DESKTOP_DOWNLOAD_URL`, so every click is a logged request. The dev server has no such route, so
  dev builds link straight to the DMG.
- `DemoVideo` plays muted, looping and inline. Under `prefers-reduced-motion: reduce` it does not
  autoplay: it shows the poster with controls. It renders nothing if the file fails to load, so a
  deployment without `demo.mp4` shows no empty frame.
- `og:image` and `og:url` are absolute (`https://linesapp.cloud/…`), because crawlers resolve
  nothing; a self-hosted deployment has to edit them.
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
