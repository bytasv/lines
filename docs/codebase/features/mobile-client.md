# Mobile client

## Purpose

Make the hosted web app usable from a phone — driving real sessions, not watching them. The agent
already ran on the user's own machine and the relay already reached it from anywhere; what was
missing was a UI a thumb can operate.

Adapted **in place** with Mantine breakpoints. There is no separate mobile shell and no
`/mobile` route, and that is a decision rather than an omission — see the architectural rules.

## Entry points

- Any hosted URL opened on a phone. There is no mode switch, no separate build, and nothing to
  turn on.
- `web/index.html` — manifest, `apple-touch-icon`, `theme-color`, `viewport-fit=cover`, so the
  app installs to an iOS home screen

## Files

- `web/src/lib/layout.ts` — `useIsPhone`, `useIsCoarse`, `useReveal`
- `web/src/lib/pointer.ts` — `revealActions`, the pure rule behind `useReveal`
- `web/src/App.tsx` — navbar as a drawer on a phone, `Burger` in the header, viewport-clamped
  sidebar width
- `web/src/index.css` — the app's first `@media` block: `env(safe-area-inset-bottom)` and touch
  target floors
- `web/src/components/BestOnDesktop.tsx` — the shared deferral panel
- `web/public/manifest.webmanifest`, `web/public/icon-*.png` — installability
- Adapted surfaces: `Composer`, `PermissionPrompt`, `SessionView`, `Sidebar`, `Transcript`,
  `ContextWindowIndicator`, `UsageIndicator`, `ProjectTabs`, `ProjectPicker`, `SettingsModal`,
  `ConnectionBanner`

## Symbols

- `useIsPhone` — viewport width below Mantine's `sm` (48em). Drives layout.
- `useIsCoarse` — `pointer: coarse`. Drives anything that assumed hover exists.
- `revealActions(hovered, coarse)` — pure; the one rule every hover-revealed control calls
- `BestOnDesktop` — stands in for a surface that is genuinely not usable at 390px

## Data flow

Nothing new travels. The phone holds the same `MachineLink`, speaks the same protocol, and (once
enrolled) the same encrypted channel as any other browser. Only presentation branches.

Two decisions are read per render rather than stored: width (`useIsPhone`) and pointer type
(`useIsCoarse`). They are deliberately distinct — a touchscreen laptop is coarse but not narrow,
an iPad in landscape is neither.

## Tests

- `server/src/pointer.test.ts` — `revealActions` under both pointer types. The repo has no
  browser test runner, so the pure half is tested from the server's runner and the rest is
  verified by hand.

## Business rules

- Phone breakpoint is Mantine's default `sm` (48em/768px). No custom breakpoints were added.
- The sidebar is a real drawer on a phone (`useDisclosure`), and picking a session closes it —
  otherwise the thing just picked sits behind it.
- Sidebar width is clamped against the viewport on every read, so a width saved on a 27" display
  cannot open a 560px drawer over a 390px screen.
- On a coarse pointer, hover-revealed actions are shown outright. They were previously
  unreachable on touch: `hovered` is never true, and the controls were gated by inline
  `opacity`/`pointerEvents`, which no CSS override can beat.
- `PermissionPrompt` becomes a bottom sheet on a phone. Dismissing it **denies** — a swipe is a
  decision, and the safe reading of it is "no", which the sheet's title says.
- Deferred behind `BestOnDesktop` on a phone: the file browser, the workflow editor, the diff
  and preview modals. `FilePalette` is simply absent — its only entry point is `mod+P`, so there
  is nothing to defer.
- `SettingsModal` goes full-screen on a phone; a 90%-wide modal leaves a sliver of backdrop that
  swallows taps meant for the pane.
- Installable, with **no service worker**. This is a live WebSocket client: offline caching buys
  nothing, and an SW-cached bundle against a newer bridge trips the version-skew path in the one
  configuration a user cannot fix by reloading, because the cache survives the reload.

## Architectural rules

- Adapt in place; do not fork a mobile shell. The argument is the transcript: `Transcript.tsx`
  sits on rAF-batched event application, `reconcileItems` referential stability, and
  `INITIAL_WINDOW` tail-windowing (see
  [transcript-performance](transcript-performance.md)). A second renderer either *is* that code —
  so it is not a fork — or it drifts and re-loses work that was hard to earn. The same holds with
  more force for `PermissionPrompt`, where the approval state machine is the product.
- `PermissionPrompt`'s phone branch is **presentation only**. One component, one approval path.
  Two answers to "may this run?" would be a security bug, not a layout one.
- `Transcript.tsx` takes layout props only. No change to batching, windowing or item identity.
- `lib/layout.ts` and `lib/pointer.ts` are separate modules on purpose: a server-side `node:test`
  imports `pointer.ts`, so it must stay free of `matchMedia` and of any package that reaches for
  it. `lib/machines.ts` is kept browser-free for the same reason.
- Fixed pixel widths on anything above a leaf icon become `maw` / `min(Npx, 100vw - 2rem)`. Most
  of the ~82 hardcoded widths in the app are menus and icon sizes and need nothing; roughly a
  dozen actually broke 390px.
- The phone is a *link*, not a mode: `hello.local` is false there, so host-side affordances (the
  Finder folder picker) are hidden by the same rule that hides them on a second laptop. See
  [hosted-machine-access](hosted-machine-access.md).

## Related decisions

- [transcript-performance](transcript-performance.md)
- [hosted-machine-access](hosted-machine-access.md)
- [end-to-end-encryption](end-to-end-encryption.md) — a phone on plain http has no WebCrypto and
  cannot enrol; it needs an https origin
- [multi-machine-client](multi-machine-client.md)
