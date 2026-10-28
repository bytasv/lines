#!/usr/bin/env node
/**
 * Renders one changelog card: a scene fragment in template.html's stage, to a 1200×675 PNG at 2×.
 *
 *   node .claude/skills/changelog-card/render.mjs <scene.html> --item "<part of the item's text>" \
 *     --out web/public/changelog-media/<name>.png [--layout app|side|stacked] [--title "<title>"]
 *
 * `app` (the default) is an item's card: the picture alone. What's new shows it under the item's
 * text, and the social draft reuses it under the post's text. `side` and `stacked` add the logo,
 * "What's new" and `--title` (the item's text when unset), for an image that travels without text;
 * the changelog does not use them.
 *
 * `--item` finds the item in changelog.json (`web`, `desktop`, then `desktopPending`) by a part of
 * its text, so the What's new preview shows the card under its own line.
 *
 * After rendering it measures the stage and warns (it does not fail) when the card will not read
 * where its layout is read (READ_WIDTH): text under MIN_SCREEN_TEXT_PX there, content outside the
 * stage that is not marked `.bleed-*`, content filling too little of the stage, or too many words for
 * one idea. Then it writes previews to look at: the card inside What's new, and at feed width.
 *
 * Chrome is the installed one (LINES_CHROME overrides the path), launched headless by playwright-core
 * with a throwaway profile, offline: the card loads nothing from the network.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const CHROME = process.env.LINES_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const scenePath = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const query = flag('--item');
const out = flag('--out');
const layout = flag('--layout') ?? 'app';

/**
 * The card's width on screen where each layout is mostly read. In What's new the image is the
 * card's 460px less its padding (2 × 20px), the timeline's indent (34px) and the bullet's (14px):
 * web/src/components/WhatsNew.tsx, `.lines-changelog` in index.css. Settings shows it wider. X's
 * feed shows a post's image 514px wide (LinkedIn about 555px).
 */
const APP_IMAGE_WIDTH = 372;
const FEED_WIDTH = 514;
const READ_WIDTH = { side: FEED_WIDTH, stacked: FEED_WIDTH, app: APP_IMAGE_WIDTH };
/** The smallest glyph box (about 1.2× the font size) that still reads, on screen. */
const MIN_SCREEN_TEXT_PX = 10;
/** Below this share of the stage, the mock is lost in empty space: zoom in or crop closer. */
const MIN_FILL = 0.45;
/** More words than this in the stage is a feature list, not one idea; in What's new the text is above. */
const MAX_WORDS = { side: 40, stacked: 40, app: 15 };
const PREVIEW_DIR = path.join(ROOT, '.debug-runs/cards/previews');

if (!scenePath || !query || !out || !(layout in READ_WIDTH)) {
  console.error(
    'usage: render.mjs <scene.html> --item "<part of the item text>" --out <file.png> [--layout app|side|stacked] [--title "<title>"]',
  );
  process.exit(2);
}

/** The same smallest text, on the 1200px card. */
const minTextPx = Math.ceil((MIN_SCREEN_TEXT_PX * 1200) / READ_WIDTH[layout]);

const textOf = (item) => (typeof item === 'string' ? item : item.text);

/** The item this card is for, by a part of its text, with the release head What's new draws above it. */
const item = (() => {
  try {
    const changelog = JSON.parse(fs.readFileSync(path.join(ROOT, 'changelog.json'), 'utf8'));
    for (const track of ['web', 'desktop']) {
      for (const release of changelog[track] ?? []) {
        const found = release.items.find((candidate) => textOf(candidate).includes(query));
        if (found) return { track, version: release.version, date: release.date, text: textOf(found) };
      }
    }
    const pending = (changelog.desktopPending ?? []).find((candidate) => textOf(candidate).includes(query));
    if (pending) return { track: 'pending', text: textOf(pending) };
  } catch {
    // No changelog.json: the preview shows the card alone.
  }
  return null;
})();
const title = flag('--title') ?? item?.text ?? query;

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Without its header comment, which names the slots too.
const template = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8').replace(/<!--[\s\S]*?-->/, '');
const logo = `<img alt="" src="data:image/png;base64,${fs
  .readFileSync(path.join(ROOT, 'web/src/assets/logo-mark.png'))
  .toString('base64')}">`;
const scene = fs.readFileSync(path.resolve(scenePath), 'utf8');
// Function replacers, so a `$` in the scene is not read as a replacement pattern.
const html = template
  .replace('{{LAYOUT}}', () => layout)
  .replace('{{LOGO}}', () => logo)
  .replace('{{TITLE}}', () => escapeHtml(title))
  .replace('{{STAGE}}', () => scene);

const HEADS = { web: 'Web app', desktop: 'Desktop app', pending: 'Next desktop release' };

/**
 * The What's new card around one item, in the dark scheme (the splash is charcoal), as
 * web/src/components/WhatsNew.tsx and ChangelogList.tsx draw it with `.lines-changelog*` and
 * `.lines-whats-new-card` from web/src/index.css. Keep the three in step.
 */
function whatsNewHtml(src, found) {
  const head = found
    ? `<span class="head-title">${HEADS[found.track]}</span>` +
      (found.version ? `<span class="version">${escapeHtml(found.version)}</span>` : '') +
      (found.date ? `<span class="date">${escapeHtml(found.date)}</span>` : '')
    : '';
  const line = found ? escapeHtml(found.text) : '';
  return `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0 }
  body { padding: 24px; background: #1e1e1e; color: #d4d4d4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased }
  .card { width: 460px; box-sizing: border-box; background: #262626; border: 1px solid #3a3a3a; border-radius: 16px; box-shadow: 0 4px 16px rgb(0 0 0 / 35%) }
  .top { padding: 20px 20px 4px }
  .title { margin: 0; font-size: 18px; line-height: 1.45; font-weight: 600 }
  .subtitle { margin-top: 2px; font-size: 12.5px; line-height: 1.55; color: #999999 }
  .list { padding: 16px 20px 20px }
  .entry { position: relative; padding-left: 34px }
  .node { position: absolute; top: 0; left: 0; box-sizing: border-box; width: 22px; height: 22px; border: 1px solid #3a3a3a; border-radius: 50%; background: #262626 }
  .entry.pending .node { border-style: dashed }
  .head { min-height: 22px; display: flex; flex-wrap: wrap; align-items: center; column-gap: 8px }
  .head-title { font-size: 12.5px; font-weight: 600 }
  .version { font-size: 11px; color: #999999; font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace }
  .date { margin-left: auto; font-size: 11px; color: #999999 }
  ul { margin: 6px 0 0; padding: 0; list-style: none }
  li { position: relative; padding-left: 14px; font-size: 12.5px; line-height: 1.55; text-wrap: pretty }
  li::before { content: ''; position: absolute; top: calc(1.55em / 2 - 2px); left: 2px; width: 4px; height: 4px; border-radius: 50%; background: #999999; opacity: 0.7 }
  .entry.pending li { color: #999999 }
  img { display: block; width: 100%; height: auto; aspect-ratio: 1200 / 675; margin-top: 8px; box-sizing: border-box; border: 1px solid #3a3a3a; border-radius: 4px }
</style>
<div class="card"><div class="top"><div class="title">What's new in Lines</div><div class="subtitle">1 update since your last visit</div></div>
<div class="list"><div class="entry${found?.track === 'pending' ? ' pending' : ''}"><span class="node"></span><div class="head">${head}</div>
  <ul><li>${line}<img src="${src}"></li></ul>
</div></div></div>`;
}

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 675 },
    deviceScaleFactor: 2,
    offline: true,
  });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  await page.screenshot({ path: path.resolve(out), clip: { x: 0, y: 0, width: 1200, height: 675 } });
  console.log(path.relative(process.cwd(), path.resolve(out)));

  const report = await page.evaluate(() => {
    const stage = document.querySelector('.stage');
    const box = stage.getBoundingClientRect();
    const describe = (el) =>
      `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;

    // Only what paints counts: a layout wrapper as big as the stage would otherwise read as full.
    const alpha = (color) => {
      const parts =
        color
          .match(/\(([^)]*)\)/)?.[1]
          .split(/[\s,/]+/)
          .filter(Boolean) ?? [];
      return parts.length > 3 ? Number.parseFloat(parts[3]) : 1;
    };
    const paints = (el) => {
      if (el.matches('img, svg, canvas, video')) return true;
      const style = getComputedStyle(el);
      return (
        alpha(style.backgroundColor) > 0 ||
        style.backgroundImage !== 'none' ||
        style.boxShadow !== 'none' ||
        ['Top', 'Right', 'Bottom', 'Left'].some(
          (side) => Number.parseFloat(style[`border${side}Width`]) > 0 && alpha(style[`border${side}Color`]) > 0,
        )
      );
    };

    const clipped = [];
    let union = null;
    const visit = (rect, el, label) => {
      if (rect.width === 0 || rect.height === 0) return;
      union = union
        ? {
            left: Math.min(union.left, rect.left),
            top: Math.min(union.top, rect.top),
            right: Math.max(union.right, rect.right),
            bottom: Math.max(union.bottom, rect.bottom),
          }
        : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      if (el.closest('.bleed-right, .bleed-bottom')) return;
      const outside =
        rect.left < box.left - 1 || rect.top < box.top - 1 || rect.right > box.right + 1 || rect.bottom > box.bottom + 1;
      if (outside && clipped.length < 5 && !clipped.includes(label)) clipped.push(label);
    };

    let smallest = null;
    let words = 0;
    const walker = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent.trim();
      if (!text || node.parentElement.closest('style, script')) continue;
      words += text.split(/\s+/).length;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.height > 0 && (smallest === null || rect.height < smallest.height)) {
          smallest = { height: rect.height, text: text.slice(0, 40) };
        }
        visit(rect, node.parentElement, `"${text.slice(0, 24)}"`);
      }
    }

    for (const el of stage.querySelectorAll('*')) {
      if (el.matches('style, script') || el.ownerSVGElement || !paints(el)) continue;
      visit(el.getBoundingClientRect(), el, describe(el));
    }
    const fill = union
      ? ((Math.min(union.right, box.right) - Math.max(union.left, box.left)) *
          (Math.min(union.bottom, box.bottom) - Math.max(union.top, box.top))) /
        (box.width * box.height)
      : 0;

    return { stage: { width: box.width, height: box.height }, smallest, words, clipped, fill };
  });

  const warnings = [];
  if (report.smallest && report.smallest.height < minTextPx) {
    warnings.push(
      `text too small: "${report.smallest.text}" is ${report.smallest.height.toFixed(1)}px tall (min ${minTextPx} for ${layout}, read ${READ_WIDTH[layout]}px wide); zoom the mock (.zoom / .zoom-3) or crop closer`,
    );
  }
  if (report.clipped.length) {
    warnings.push(
      `outside the stage: ${report.clipped.join(', ')}; it overlaps the title or is cut by the card edge. Shrink it, or mark a deliberate crop .bleed-right / .bleed-bottom`,
    );
  }
  if (report.fill < MIN_FILL) {
    warnings.push(`content fills ${(report.fill * 100).toFixed(0)}% of the stage (min ${MIN_FILL * 100}%); zoom in`);
  }
  if (report.words > MAX_WORDS[layout]) {
    warnings.push(`${report.words} words in the stage (max ${MAX_WORDS[layout]}); show one idea, not a feature list`);
  }
  console.log(
    `stage ${report.stage.width}×${report.stage.height}, smallest text ${report.smallest ? report.smallest.height.toFixed(1) + 'px' : 'none'}, fill ${(report.fill * 100).toFixed(0)}%, ${report.words} words`,
  );
  for (const warning of warnings) console.log(`warning: ${warning}`);

  // The card as its readers get it: the PNG scaled down by the browser, on a 1× screen (the worst
  // case). Never next to `--out`, which ships with the app.
  const src = `data:image/png;base64,${fs.readFileSync(path.resolve(out)).toString('base64')}`;
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  if (!item) console.log(`note: no item containing "${query}" in changelog.json; the What's new preview shows the card alone`);
  const previews = [
    { name: 'dialog', where: "in the app's What's new card", width: 508, html: whatsNewHtml(src, item) },
    {
      name: String(FEED_WIDTH),
      where: 'at feed width (X, LinkedIn)',
      width: FEED_WIDTH,
      html: `<style>html, body { margin: 0 } img { display: block; width: ${FEED_WIDTH}px }</style><img src="${src}">`,
    },
  ];
  for (const { name, where, width, html: previewHtml } of previews) {
    const small = await browser.newContext({ viewport: { width, height: 300 }, deviceScaleFactor: 1, offline: true });
    const preview = await small.newPage();
    await preview.setContent(previewHtml, { waitUntil: 'load' });
    const file = path.join(PREVIEW_DIR, `${path.basename(out, '.png')}-${name}.png`);
    await preview.screenshot({ path: file, fullPage: true });
    await small.close();
    console.log(`preview ${where}: ${path.relative(process.cwd(), file)}`);
  }
} finally {
  await browser.close();
}
