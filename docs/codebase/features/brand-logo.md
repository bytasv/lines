# Brand logo assets

## Purpose

Renders the Lines brand mark across the three surfaces that show it: the tab-bar header, the
browser tab favicon, and the desktop notification icon. There is no wordmark anywhere anymore —
the header shows the mark plus `alt="Lines"` for the accessible name, no `<Text>Lines</Text>` and
no wordmark baked into the art.

## Entry points

- `web/src/components/ProjectTabs.tsx` — tab-bar header brand
- `web/index.html` — `<link rel="icon">`
- `web/src/lib/favicon.ts` — favicon canvas with the attention/running badge overlay
- `web/src/lib/alerts.ts` — desktop notification icon

## Important files

- `web/src/assets/logo-mark.png` — 122×128 RGBA, transparent background, no baked corner mask;
  header only
- `web/src/assets/logo-mark-solid.png` — 128×128 RGBA, opaque white square with a baked
  rounded-rect corner mask; notification icon
- `web/public/favicon.png` — same bytes as `logo-mark-solid.png`, served from `/public` so
  `index.html` can reference it by URL
- `web/src/index.css` — the `.brand-wordmark` rules are gone along with the DOM wordmark. The
  `.brand-separator` dot this file used to note is gone too, replaced in the header by
  [`MachineSwitcher`](multi-machine-client.md)

## Data flow

`ProjectTabs` imports `logo-mark.png` through Vite's asset pipeline and renders it inside a white
rounded plate (the PNG has no background of its own). `favicon.ts` loads `/favicon.png` into an
`Image`, and `drawLogo` letterboxes it into a 64px square canvas before `render` overlays the red
attention count or blue running dot; when idle, `restorePlain` points the `<link>` straight back
at the plain PNG.

## Business rules

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
