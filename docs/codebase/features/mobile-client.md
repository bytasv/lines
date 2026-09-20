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
- `web/src/lib/viewport.ts` — `trackKeyboardInset`, which publishes `--lines-keyboard`
- `web/src/App.tsx` — navbar as a drawer on a phone, `Burger` in the header, viewport-clamped
  sidebar width
- `web/src/components/ProjectTabs.tsx` — `HeaderActions`: the trailing controls as an icon row or
  a single overflow menu
- `web/src/index.css` — `--lines-viewport`/`--lines-keyboard`, and the `@media` block:
  `env(safe-area-inset-bottom)`, the 16px input floor, and touch target floors
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
- `--lines-viewport` — `calc(100dvh - var(--lines-keyboard))`; the height a full-screen surface
  may actually occupy. Every full-height box uses it instead of `100vh`
- `trackKeyboardInset()` — measures the on-screen keyboard from `visualViewport` and publishes it
  as `--lines-keyboard`. Started once in `main.tsx`, never torn down
- `HeaderActions` — documentation, theme and settings: an icon row on a desktop, one overflow
  menu on a phone

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
- No full-height surface uses `100vh`. On a phone `vh` is the *large* viewport — measured as if
  the browser's toolbars were hidden — so a `100vh` shell puts its bottom row, which here is the
  composer, underneath Safari's toolbar. Mantine's own `AppShell` already uses `dvh`, so anything
  still on `vh` disagreed with the framework by exactly the height of the toolbar.
- The shell also subtracts the keyboard. iOS does not resize the layout viewport when the
  keyboard opens — it shrinks the *visual* viewport and leaves the page as tall as it was, and
  `dvh` does not move either — so the composer ended up under the keyboard the moment it was
  tapped. `trackKeyboardInset` measures the difference and the shell shrinks by it.
  `interactive-widget=resizes-content` in the viewport meta does the same on Chrome; there the
  measurement reads ~0 and adds nothing, so the two do not stack.
- Inputs are 16px on a phone. Below that, iOS Safari zooms the page in on focus and does not zoom
  back out on blur, which leaves the app permanently magnified with no fix but a manual pinch.
  Mantine's default is `sm` (14px), so every field in the app tripped it.
- The header's trailing controls fold into one overflow menu on a phone, and the brand mark is
  dropped there. Burger, brand, tabs and five controls do not fit in 390px, and the tabs are what
  gets squeezed out — so the row loses the one thing in it that does nothing.
- Icon-only controls have a 32px floor on a phone, applied to `.mantine-ActionIcon-root` rather
  than per call site. It is a floor, not a size: a 44px minimum was tried across buttons, menu
  items, inputs and segments, and the result was an app where every control shouted and a
  three-mode segmented control stood taller than the text above it. Mantine's own sizes already
  clear 32px for anything carrying a label, so the floor only has to catch the mouse-tuned
  icon buttons.
- The composer's own text is 15px, and 16px on iOS, where the zoom rule below applies.
  `@supports (-webkit-touch-callout: none)` is the platform test — that property exists on
  WebKit/iOS and nowhere else, so Chrome on iOS correctly keeps the floor too.
- A bottom sheet is sized by its content (`size="auto"`), not by a share of the screen. A sheet
  pinned at 80dvh is the same height whether it holds four controls or one, and four controls do
  not fill a phone; `.lines-mobile-sheet`'s max-height is what stops a long one running off the
  top.
- The composer's Options button is labelled with the current permission mode, so one control both
  reports the setting that matters before you send and opens the sheet that changes it.
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
- A phone-only branch that owns state must mount that state *above* the branch. `HeaderActions`
  exists as one component rather than three because the settings modal cannot live inside the
  overflow menu: choosing "Settings" closes the menu, which unmounts the dropdown and takes the
  modal with it.
- Fixed pixel widths on anything above a leaf icon become `maw` / `min(Npx, 100vw - 2rem)`. Most
  of the ~82 hardcoded widths in the app are menus and icon sizes and need nothing; roughly a
  dozen actually broke 390px.
- The phone is a *link*, not a mode: `hello.local` is false there, so host-side affordances (the
  Finder folder picker) are hidden by the same rule that hides them on a second laptop. See
  [hosted-machine-access](hosted-machine-access.md).

## Conversation layout

- On phones, the composer keeps attachment, Options, and Send/Queue/Stop in one non-wrapping
  row. The current permission mode remains visible above the input. Model, reasoning effort,
  permissions, and context details live in a bottom Options sheet; desktop controls stay inline.
- The project header shows the active project and opens a searchable bottom sheet. Project paths
  distinguish duplicate names, while existing status indicators and management actions remain
  available. Management dialogs are owned above the responsive branch so resizing preserves them.
- Phone session rows expose one labeled overflow menu. Existing action restrictions and delete
  confirmations still apply, and opening the menu does not navigate to the session.
- Bottom sheets use the same keyboard inset and safe-area spacing as the composer. Context details
  render inline inside Options so reading them does not require hover.
- Browser checks should cover narrow widths (360, 390, and 430px), running and idle actions, draft
  preservation across sheets and resizing, project filtering, and session-menu navigation isolation.
  Physical-device keyboard behavior still requires Safari/Chrome verification.

## Related decisions

- [transcript-performance](transcript-performance.md)
- [hosted-machine-access](hosted-machine-access.md)
- [end-to-end-encryption](end-to-end-encryption.md) — a phone on plain http has no WebCrypto and
  cannot enrol; it needs an https origin
- [multi-machine-client](multi-machine-client.md)
