# What's new

## Purpose

Tell a user what changed since they last opened Lines. After an update, the first load shows a
"What's new" card listing every user-facing change since the versions this browser last saw, with
the app already loaded behind it; closing it plays the splash's fade-out/fade-in hand-over. Going
from 0.1.0 to 0.5.0 lists everything in between. Settings → What's new keeps the whole history.

## Entry points

- `web/src/main.tsx` — `AppWhenReady` decides at lift whether there is news, holds the splash, and
  portals the card into the splash slot
- `web/src/App.tsx` — mounts `DesktopUpdateWhatsNew` for updates that arrive mid-session
- `web/src/components/SettingsModal.tsx` — the `whatsNew` section (System group, after `updates`)
- `desktop/scripts/stamp-changelog.mjs` — moves pending desktop notes into a release
- `scripts/changelog/announce.mjs` — after deploy, sends added releases to social-driver as drafts

## Files

- `changelog.json` (repo root) — the data
- `shared/changelog.ts` — types, item accessors and the version rules; re-exported from `shared/types.ts`
- `web/public/changelog-media/` — the item card images, served from the site root
- `.claude/skills/changelog-card/` — the skill that renders a card per item (`SKILL.md`, `render.mjs`,
  `template.html`); its previews go to `.debug-runs/`, which is not committed
- `scripts/changelog/added.mjs` — which releases a deploy added, by track and version
- `scripts/changelog/announce.mjs` — the announce step's payloads and signed webhook call
- `.github/workflows/deploy.yml` — the `announce` job, after `deploy`, on main pushes only
- `web/src/lib/whatsNew.ts` — localStorage markers and the show/don't-show decision
- `web/src/lib/splash.ts` — `holdApp`, `splashSlot`
- `web/src/components/WhatsNew.tsx`, `WhatsNewModal.tsx`, `WhatsNewSection.tsx`,
  `ChangelogList.tsx`
- `web/src/components/UpdatesSection.tsx` — the "What's new" button on the web version row
- `web/vite.config.ts`, `web/src/vite-env.d.ts` — bake `changelog.json` in as `__LINES_CHANGELOG__`
- `web/src/index.css`, `web/src/loader.css` — timeline and card styling; centring while held
- `desktop/scripts/ship.mjs`, `desktop/scripts/stamp-changelog.mjs`,
  `.github/workflows/release-desktop.yml`, `desktop/package.json`
- `deploy/docker/Dockerfile` — the web build stage copies `changelog.json`
- `server/src/claudeCli.ts` — re-exports `compareVersions`, which now lives in `shared/changelog.ts`

## Symbols

- `Changelog`, `ChangelogRelease`, `releasesSince`, `nextSeen`, `compareVersions`
- `pendingWhatsNew`, `desktopUpdateNews`, `markSeen`, `previouslySeen`, `CHANGELOG`
- `holdApp`, `splashSlot`
- `WhatsNew`, `WhatsNewPanel`, `WhatsNewModal`, `DesktopUpdateWhatsNew`, `WhatsNewSection`,
  `ChangelogList`
- `ChangelogItem`, `itemText`, `itemImage`
- `stampChangelog`, `stampFile`
- `addedReleases`

## Data flow

**Data.** `changelog.json` holds two tracks, `web` and `desktop`, each newest first as
`{version, date, items[]}`, plus `desktopPending`: desktop notes committed since the last desktop
release. An item is a plain string or `{text, image?}`; `image` is a file name only, a card under
`web/public/changelog-media/`. The card is drawn under the item's line in What's new and in Settings. Vite reads it at config time and bakes it into the bundle, so a web deploy always carries
the latest file.

**Two markers.** `localStorage` keys `lines.seenWeb` and `lines.seenDesktop` record the newest
version of each track this browser has seen. The web part is judged at module load against
`__LINES_VERSION__`; the desktop part against the bridge version in the first `hello` (a packaged
bridge reports `desktop/package.json`'s version). If boot gave up waiting for a `hello`, the
desktop part is skipped that load. Either track past its marker shows every release in between.

**Boot.** `AppWhenReady` calls `pendingWhatsNew` once at lift (never for a guest). With news it
calls `holdApp()` beside `awaitApp()`: the splash stops at the finished mark, the app mounts unseen
beneath, and the card shows in the splash slot. Continue (or Enter/Esc) calls `markSeen`, releases
the hold, and the usual hand-over runs. The card unmounts once the splash is `hidden`.

**Mid-session.** A desktop update relaunches the bridge and the open tab reconnects with no
splash. `DesktopUpdateWhatsNew` watches `bridge.version`; a version above the marker with releases
in range opens `WhatsNewModal`, and closing it marks them seen. Web updates need a reload and show
through the boot path.

**Cards.** The changelog-card skill renders one 1200×675 PNG per visible item from an HTML scene,
checks that its text reads at the card's on-screen width, and writes two previews (the item in
What's new, and at feed width). Its file is named `<track>-<version>-<slug>.png`, or
`desktop-next-<slug>.png` for a pending item. A pending item keeps that name when stamped.

**Announce.** After a push to main that deploys, `announce.mjs` compares `changelog.json` at the
previous and new commits and POSTs each release the push added to social-driver, HMAC-signed with
`X-Lines-Signature`, as a draft post. The image URL is built against `LINES_PUBLIC_URL`. Payload
titles are derived from the first sentence of each item, since items have no title of their own.
Pending desktop items are never sent.

**Settings.** Settings → What's new renders the whole changelog on one timeline, newest first, with
a "New" badge on releases above what this browser had seen when the page loaded, and a dashed
"Next desktop release" entry while `desktopPending` is non-empty.

**Producing entries.** The Lines dev workflow's commit step writes one user-worded line per
user-facing commit (feat, or a fix a user would notice; never docs, chore, refactor, tests). Paths
under `web/` go to the web track: bump `web/package.json`'s patch version and prepend a release.
Paths under `desktop/`, `server/` or `shared/` go to `desktopPending`. `ship.mjs` stamps pending
notes into a new `desktop` release when it commits a version bump, in the same commit.

## Tests

- `server/src/changelog.test.ts` — `releasesSince` bounds and skipped versions, `nextSeen` never
  moving back and capping at the newest known release, `itemText` and `itemImage` for both item
  shapes, and the shape of the real `changelog.json` (strictly descending, valid dates, non-empty
  items, each image a lower-case PNG name that exists in `web/public/changelog-media/`)
- `desktop/scripts/stamp-changelog.test.mjs` — pending items move into the release, no-op when
  nothing is pending, refuses a version that already exists, an image item survives stamping
- `scripts/changelog/added.test.mjs` — added releases per track, an edited release is not added
  again, pending items are never added, a missing `from` adds everything
- `server/src/claudeCli.test.ts` — still covers `compareVersions` through the re-export

## Business rules

- A missing marker (first visit, or the first load after this feature) is written silently and
  shows nothing.
- Markers only move forward. A desktop version below the marker (connecting to an older machine)
  never moves it back.
- `nextSeen` caps at the newest release the bundle knows. If a desktop release ships before the web
  app redeploys with its stamped notes, the marker stops short of the missing entries so they show
  on a later load.
- The decision is latched per page load: a machine switch remounts the app and replays the splash
  but never reshows the card.
- Guests never see the card or the mid-session modal; the host's desktop app is not theirs.
- If the splash is already gone when the app starts, `holdApp()` returns null: no card, nothing
  marked seen, so the notes show on the next load.
- Desktop notes have no version until released, so they sit in `desktopPending` and are shown only
  in Settings until `ship.mjs` stamps them.
- A CI release cannot commit: the workflow's guard job fails if `desktopPending` is non-empty,
  with a hint to run `npm run changelog:stamp -w desktop` and commit first (skipped on a dry run).
- Stamping refuses a desktop version that already has a release.
- A pending desktop item's image name is opaque: stamping moves the item verbatim, so the file
  stays `desktop-next-…` after release.
- The announce job is `continue-on-error` and runs only on main pushes; with either webhook secret
  unset it prints a notice and exits 0.
- Commits made outside the workflow add no entry and no web bump; the cost is a missing line.

## Architectural rules

- The card is not a gate: the app mounts and loads behind it exactly as it does without one.
- While held, the splash's fallback timer is suspended, so an open card is never faded away.
- While held, the splash centres the mark and the card as one group, and glides them when the card
  changes size (`data-held` in `loader.css`, a `ResizeObserver` in `splash.ts`). The splash layer
  clips outside `shown`, so the card caps its height and scrolls its list internally.
- `compareVersions` lives in `shared/changelog.ts`; `server/src/claudeCli.ts` re-exports it so
  `codexCli.ts` and the existing tests are unchanged.
- The announce job runs after deploy, so a card's image URL resolves before a draft links to it. A
  social failure never marks the deploy red.
- The web version is bumped per user-facing commit, so `__LINES_VERSION__` now moves with the
  changelog.
- Dev builds never show the desktop part by themselves: an unpackaged bridge reports
  `server/package.json`'s 0.1.0, below every desktop entry. Test it by lowering `lines.seenDesktop`.

## Related decisions

- [brand-logo](brand-logo.md) — the boot splash and its hand-over that the card holds
- [settings-updates-pane](settings-updates-pane.md) — the sibling pane, and the web version it shows
- [desktop-app](desktop-app.md) — `ship.mjs` and the release workflow that stamp and guard the notes
