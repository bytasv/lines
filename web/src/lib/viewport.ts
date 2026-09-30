/**
 * How much of the layout viewport the on-screen keyboard is covering, published
 * as the `--lines-keyboard` CSS variable.
 *
 * The app is a fixed-height shell: header, a scrolling transcript, and a
 * composer pinned at the bottom. Nothing about that arrangement reacts to a
 * keyboard on iOS, because iOS does not resize the *layout* viewport when the
 * keyboard opens — it shrinks the **visual** viewport and leaves the page
 * exactly as tall as it was. `100dvh` does not move either; it is the dynamic
 * viewport with respect to the browser's own toolbars, not to the keyboard. So
 * the composer you just tapped into ends up underneath the keyboard, which is
 * the single thing that makes typing on a phone impossible rather than merely
 * cramped.
 *
 * `visualViewport` is what actually knows. Subtracting the inset from the shell
 * height puts the composer directly above the keyboard, which is where the
 * caret is.
 *
 * Chrome's `interactive-widget=resizes-content` (set in `index.html`) already
 * shrinks the layout viewport, so this measures ~0 there and correctly adds
 * nothing — the formula is self-correcting rather than platform-branched.
 */

import { diag, diagEntries } from './diag';
import { sendDiagnostics } from './storage';

/** Below this, a difference is a collapsing URL bar or rounding, not a keyboard. */
const KEYBOARD_MIN_PX = 80;

/** A keyboard is only ever up for a field that has focus. */
function editing(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
}

export function trackKeyboardInset(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};

  const apply = () => {
    // Pinch-zoom shrinks the visual viewport too, and a zoomed-in user has not
    // opened a keyboard — reading that as one would collapse the app around
    // them. Nothing focused means no keyboard either: iOS can leave the visual
    // viewport short after the keyboard closes, and trusting it then leaves an
    // empty band under the composer until something else resizes the page.
    const inset = vv.scale > 1 || !editing() ? 0 : window.innerHeight - vv.height - vv.offsetTop;
    const px = inset > KEYBOARD_MIN_PX ? Math.round(inset) : 0;
    const root = document.documentElement;
    root.style.setProperty('--lines-keyboard', `${px}px`);
    // For CSS that has to change shape rather than size, e.g. dropping the
    // home-indicator padding the keyboard now covers.
    root.toggleAttribute('data-keyboard', px > 0);
    recordViewport(px);
  };
  // Focus moves before the keyboard animates, and on focusout activeElement is
  // not yet settled — read it a frame later.
  const onFocusChange = () => requestAnimationFrame(apply);

  apply();
  // `scroll` as well as `resize`: iOS scrolls the visual viewport to keep the
  // caret in sight, which moves `offsetTop` without changing its height.
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  document.addEventListener('focusin', onFocusChange);
  document.addEventListener('focusout', onFocusChange);
  return () => {
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
    document.removeEventListener('focusin', onFocusChange);
    document.removeEventListener('focusout', onFocusChange);
  };
}

/*
 * TEMPORARY — remove once the home-screen bottom gap is understood. In a
 * standalone app only, records the numbers that decide the shell height into the
 * diag buffer and uploads them (storage logs, `[diag]`), since a home-screen app
 * has no URL bar to open a readout with. Numbers only: no content, no URLs.
 */
let lastSnapshot = '';
let uploadTimer: ReturnType<typeof setTimeout> | null = null;
let uploads = 0;
const MAX_UPLOADS = 20;

function recordViewport(keyboardPx: number) {
  if (!matchMedia('(display-mode: standalone)').matches) return;
  const vv = window.visualViewport;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:100dvh;' +
    'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);box-sizing:content-box';
  document.body.append(probe);
  const cs = getComputedStyle(probe);
  const d = {
    innerHeight: window.innerHeight,
    vvHeight: Math.round(vv?.height ?? -1),
    vvOffsetTop: Math.round(vv?.offsetTop ?? -1),
    screenHeight: screen.height,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
    scrollY: Math.round(window.scrollY),
    dvh: parseFloat(cs.height),
    safeTop: parseFloat(cs.paddingTop),
    safeBottom: parseFloat(cs.paddingBottom),
    keyboard: keyboardPx,
    editing: editing(),
  };
  probe.remove();
  const snapshot = JSON.stringify(d);
  if (snapshot === lastSnapshot) return;
  lastSnapshot = snapshot;
  diag('viewport', d);
  if (uploads >= MAX_UPLOADS) return;
  if (uploadTimer) clearTimeout(uploadTimer);
  uploadTimer = setTimeout(() => {
    uploadTimer = null;
    uploads += 1;
    const recent = diagEntries().filter((e) => e.k === 'viewport').slice(-30);
    sendDiagnostics(null, recent).catch(() => {});
  }, 3000);
}
