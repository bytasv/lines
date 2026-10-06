# Brand logo assets

## Purpose

Renders the Lines brand mark across the surfaces that show it: the tab-bar header, the browser tab
favicon, the desktop notification icon, and the animated boot splash. There is no wordmark anywhere anymore —
the header shows the mark plus `alt="Lines"` for the accessible name, no `<Text>Lines</Text>` and
no wordmark baked into the art.

## Entry points

- `web/src/components/ProjectTabs.tsx` — tab-bar header brand
- `web/index.html` — `<link rel="icon">`
- `web/src/lib/favicon.ts` — favicon canvas with the attention/running badge overlay
- `web/src/lib/alerts.ts` — desktop notification icon
- `web/src/lib/splash.ts` — controller for the boot splash declared in `web/index.html`

## Important files

- `web/src/assets/logo-mark.png` — 122×128 RGBA, transparent background, no baked corner mask;
  header only
- `web/src/assets/logo-mark-solid.png` — 128×128 RGBA, opaque white square with a baked
  rounded-rect corner mask; notification icon
- `web/public/favicon.png` — same bytes as `logo-mark-solid.png`, served from `/public` so
  `index.html` can reference it by URL
- `web/src/loader.css` — the splash layer, the animated mark's keyframes, and the fades; linked
  straight from `index.html` so it paints before any script runs
- `web/src/index.css` — the `.brand-wordmark` rules are gone along with the DOM wordmark. The
  `.brand-separator` dot this file used to note is gone too, replaced in the header by
  [`MachineSwitcher`](multi-machine-client.md)

## Data flow

`ProjectTabs` imports `logo-mark.png` through Vite's asset pipeline and renders it inside a white
rounded plate (the PNG has no background of its own). `favicon.ts` loads `/favicon.png` into an
`Image`, and `drawLogo` letterboxes it into a 64px square canvas before `render` overlays the red
attention count or blue running dot; when idle, `restorePlain` points the `<link>` straight back
at the plain PNG.

## Boot splash

`web/index.html` holds the splash markup outside `#root`: a vector copy of the mark that loops at
0.5× speed over a faint copy of `logo-mark.png`, with a caption beneath. It paints before any
script runs (unless skipped, see below) and is one persistent element, so the loop never restarts between boot steps. React
never renders it; `lib/splash.ts` only swaps the caption and drives its state
(`shown` → `finishing` → `finished` → `leaving` → `hidden`). There is no header on it. The
account menu appears top-right only while the connecting help is showing.

The splash is for the app only. A small synchronous script right after the markup
(`web/public/splash-guard.js` — a file rather than inline, because the deployed CSP allows no
inline script, and it reads whether Clerk is configured from `#lines-splash`'s `data-clerk`
attribute) hides it before first paint when Clerk is configured and the route is `/welcome` or
`/join/:code`, or the visitor has no signed-in Clerk cookie (`__client_uat*` missing or `0`), so
the landing page appears immediately.
`lib/splash.ts` exports `splashSkippedAtBoot` so the root route knows. The cookie is a guess: if
a signed-in user is taken for a guest, the app's first claim brings the splash back over the
landing page. Builds without Clerk always keep the splash.

Each boot step holds the splash with its own caption: "Starting Lines…" (static HTML),
"Signing you in…", "Finding your machines…", "Connecting to <machine>…", "Loading your sessions
and projects…", "Opening your session…". The connecting help panel (see
[hosted-machine-access](hosted-machine-access.md)) is portalled into the splash slot.

Hand-over to the app is sequential, so nothing heavy runs while the loop is on screen: the mark
finishes drawing onto the static logo, the app mounts hidden beneath it, the splash fades out,
and the app fades in the moment the splash is gone. When the app opens on a session with no
transcript loaded, the splash also waits for that transcript, capped at 6s. This happens once per
page load; switching machines remounts the app and replays the sequence. Reduced motion shows a
static mark with a slow opacity pulse; the fades stay.

After an update the hand-over can be held by the What's new card (see [whats-new](whats-new.md)).
`holdApp()` keeps the splash at the finished mark and suspends the 4s fallback while the card shows
in the splash slot (`splashSlot()`); the caption is blanked, the mark and card are centred as one
group and glide when the card changes size, and releasing the hold runs the usual two-frame wait
and fade.

## Business rules

- The splash mark is a hand-built SVG in `index.html`, separate from the PNG assets; changing the
  mark means changing that markup as well as the PNGs.
- The splash is skipped before first paint for landing routes and signed-out visitors (Clerk cookie
  heuristic); a later app claim shows it again.
- The splash layer scrolls only while `shown` (the connecting help panel); in every later state it
  clips, so the hand-over scale and the app mounting beneath cannot produce scrollbars.
- The splash is never rendered by React and is never remounted, so animation state survives every
  boot step and machine switch.
- The app is not rendered at all until the mark has finished and the splash is ready to hand over;
  a 4s fallback fades the splash anyway if an expected app never mounts.

- The header, favicon, and notification icon all use the same mark artwork now (no separate
  lockup) — `logo-mark.png` for the header, `logo-mark-solid.png`/`favicon.png` for the other two.
- `favicon.png` and `logo-mark-solid.png` are deliberately the same image at two paths:
  `index.html` needs a `/public` URL, `alerts.ts` wants a Vite asset import. Collapsing them would
  mean hardcoding `'/favicon.png'` in `alerts.ts`.
- The header `<img>` is height-driven (`height={24}`, `width: 'auto'`) inside a plate with
  `padding: 4` and `borderRadius: 6`.
- `alt="Lines"` on the header `<img>` is the only accessible name for the brand.

## Architectural rules

- **The white plate in `ProjectTabs` is load-bearing.** `logo-mark.png` is transparent with no
  background of its own, so without the plate the near-black art would sit directly on the dark
  header with no ground behind it. The plate also supplies the header's corner rounding — the
  header asset carries no baked mask.
- **The favicon/notification asset bakes its own rounded corners.** Unlike the header art,
  `logo-mark-solid.png`/`favicon.png` mask their own corners (transparent, RGBA) because nothing
  downstream — the favicon `<link>`, the `Notification` icon — can round them at render time.
- `link.type` must track the real bytes. `index.html` declares `image/png`, and `restorePlain` in
  `favicon.ts` sets `image/png` to undo the `image/png` data-URL that `render` installs.

## Source art

The committed files are cropped derivatives of a 1254×1254 RGB-on-white source PNG — **not in the
repo**. A throwaway `zlib`-only Node script: un-multiplies the white background to recover true
alpha (`a = 255 - min(r,g,b)`, then unmultiplies color by that alpha — not a chroma key, so
anti-aliased edges survive), crops to content bbox plus padding, and area-averages down to the
target size. The favicon/notification variant additionally gets a supersampled rounded-rect alpha
mask baked in (18% of the short side) since nothing downstream can round it. A future re-crop or
re-tone should start from the original source, not from these derivatives.

## Tests

None. Every failure mode here is visual (crop margins, mark legibility at small sizes, badge
overlap on the favicon); `npm run build` and `npm run typecheck` in `web/` catch a broken asset
import, which is the only mechanical risk.

## Related decisions

None recorded.
