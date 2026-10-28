---
name: changelog-card
description: Use after writing a changelog.json item for a visible change, or when asked for a card image for a change. Makes one illustrative 1200×675 PNG for the item (shown under it in the app's "What's new" and used for the social draft) and turns the item into `{ "text", "image" }`.
---

# A card for one changelog item

One card per item, showing **one idea**. It is seen under the item's line in the app's "What's new"
(about 372px wide) and as the image of the draft post social-driver makes from the release, so it
has to read at a third of its size.

## Steps

1. **Pick the idea.** Read the item (`changelog.json`) and the diff behind it. Decide the one thing
   to show: a before and after, a mini mock of the part of Lines that changed (a few sidebar rows,
   a transcript turn, the composer, a settings row), or a short flow (two or three steps with
   arrows). Not a feature list.

   **Scale is the whole job.** A feature may span the app; the card shows its essence. The one row,
   control, message or button that changed is the focal point, and the mock holds only enough
   around it to say where it lives (3–6 sidebar rows, not the sidebar). Never shrink a whole page or
   panel to fit: crop a fragment and let it run off the card's edge (`.bleed-*`). If the change only
   reads as a sequence, use a flow in the `stacked` layout, at most three steps.

   **The item's card is the `app` layout** (the default): the picture alone. What's new shows it
   under the item's text, and the social draft reuses it under the post's text, so a frame or a
   title on the card would only repeat them. `side` and `stacked` add the logo, "What's new" and a
   title, for an image that travels without text; the changelog does not use them.

   The numbers (the card is 1200px wide):
   - `app` stage: 1104×595, read about 372px wide in What's new (under a third) and 514px in X's
     feed: use `.zoom-3`, and text must be at least 33px tall on the card.
   - `side` stage: 664×563, `stacked`: 1072×~452, read about 514px wide in X's feed: use `.zoom`,
     and text must be at least 24px tall.
   - Mock at the app's true 11–12.5px (`.ui`, `.ui-small`) inside the zoom, never unzoomed: 12.5px
     at `.zoom-3` is 37.5px on the card, about 11.6px in What's new.
   - The mock should fill roughly half of the stage or more. A small window floating in empty space
     reads as nothing at thumbnail size.

2. **Write the scene** to `.debug-runs/cards/<slug>.html`: one self-contained HTML fragment (no
   `<html>`, no external URLs). It lands in the template's stage (sizes above).
   - Use only the template's CSS variables (`--accent`, `--accentLight`, `--blue`, `--green`,
     `--yellow`, `--red`, `--text`, `--textMuted`, `--line`, `--panel`, `--body`, `--deep`,
     `--menuShadow`, `--radius`, `--font`, `--mono`) and its helpers (`.window`, `.ui`,
     `.ui-small`, `.zoom`, `.zoom-3`, `.bleed-right`, `.bleed-bottom`, `.arrow` and `.label` for
     flows, `.highlight` for the focal element). They are Lines' dark scheme: monochrome, with
     colour only for status (blue running, green done, yellow needs you, red error) and indigo
     (`--accent`) for the one thing the card points at. Inline `<style>` in the fragment is fine.
   - Icons: paste the SVG markup of the app's own set, Tabler outline, from
     `node_modules/@tabler/icons/icons/outline/<name>.svg` (the names match `@tabler/icons-react`'s
     `Icon…` imports in `web/src`). No other icon libraries, no emoji — generic looks get rejected.
   - Mock the UI with made-up but plausible content (session names, prompts, file paths). **Never**
     screenshot real user data, a real machine or a real project.

3. **Render**:
   ```sh
   node .claude/skills/changelog-card/render.mjs .debug-runs/cards/<slug>.html \
     --item "<a part of the item's text>" --out web/public/changelog-media/<name>.png
   ```
   `<name>` is `<track>-<version>-<slug>` (`web-0.1.37-dictation-timer`), or `desktop-next-<slug>`
   for an item in `desktopPending`: it has no version yet, and its name stays as it is when the
   release stamps it.

   Needs the installed Chrome (`LINES_CHROME` overrides its path). It runs headless, offline, in a
   throwaway profile. It then prints the stage size, the smallest text, how much of the stage the
   mock fills and the word count, with a `warning:` line for each check that fails: text under the
   layout's minimum, anything outside the stage that is not marked `.bleed-*`, under 45% fill, too
   many words (15 for `app`, 40 otherwise). Fix every warning unless you can say why it is wrong for
   this card. It also writes two previews to `.debug-runs/cards/previews/`, both on a 1× screen:
   `<name>-dialog.png`, the card in the What's new card under its item's text (found in
   `changelog.json` by `--item`), and `<name>-514.png`, the card at X's feed width.

4. **Look at it** with Read on the previews (`-dialog.png` first, then `-514.png`), not only the
   full PNG: a full-size image hides what is unreadable small.
   Check: legible there, one focal point the eye lands on first, the change itself visible (not only
   its surroundings), nothing clipped by accident, no lorem ipsum. Fix the scene and re-render — at
   most 3 rounds.

5. **Set the image** on the item: replace its string with
   `{ "text": "<the same text>", "image": "<name>.png" }` (file name only). The changelog test
   checks the file exists in `web/public/changelog-media/` and is named in lower case.

## Files

- `template.html` — the frame: logo and wordmark, "What's new" eyebrow, title, stage (the `app`
  layout hides all but the stage). Inlined styles, system fonts, nothing fetched.
- `render.mjs` — fills the template, screenshots it at 1200×675 (deviceScaleFactor 2), reports the
  scale checks above and writes the previews. Its What's new preview copies
  `web/src/components/WhatsNew.tsx`, `ChangelogList.tsx` and `.lines-changelog*` in
  `web/src/index.css`: keep them in step.
