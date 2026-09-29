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

/** Below this, a difference is a collapsing URL bar or rounding, not a keyboard. */
const KEYBOARD_MIN_PX = 80;

export function trackKeyboardInset(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};

  const apply = () => {
    // Pinch-zoom shrinks the visual viewport too, and a zoomed-in user has not
    // opened a keyboard — reading that as one would collapse the app around
    // them.
    const inset = vv.scale > 1 ? 0 : window.innerHeight - vv.height - vv.offsetTop;
    const px = inset > KEYBOARD_MIN_PX ? Math.round(inset) : 0;
    document.documentElement.style.setProperty('--lines-keyboard', `${px}px`);
  };

  apply();
  // `scroll` as well as `resize`: iOS scrolls the visual viewport to keep the
  // caret in sight, which moves `offsetTop` without changing its height.
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  return () => {
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
  };
}

/**
 * TEMPORARY — remove before commit. `?diag=viewport` pins a readout of the numbers
 * that decide the standalone-PWA bottom gap, so the `--lines-viewport` correction
 * in index.css can be checked on a real device.
 */
export function mountViewportDiag(): void {
  if (new URLSearchParams(window.location.search).get('diag') !== 'viewport') return;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:100dvh;' +
    'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);box-sizing:content-box';
  // Resolves the variable to pixels; getPropertyValue would return the calc() text.
  const shell = document.createElement('div');
  shell.style.cssText =
    'position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:var(--lines-viewport)';
  const out = document.createElement('pre');
  out.style.cssText =
    'position:fixed;top:40%;left:8px;z-index:99999;margin:0;padding:6px;font:11px/1.3 monospace;' +
    'background:rgba(0,0,0,.8);color:#0f0;pointer-events:none;white-space:pre';
  document.body.append(probe, shell, out);
  const render = () => {
    const cs = getComputedStyle(probe);
    const root = getComputedStyle(document.documentElement);
    const vv = window.visualViewport;
    out.textContent = [
      `standalone ${matchMedia('(display-mode: standalone)').matches}`,
      `innerHeight ${window.innerHeight}`,
      `vv.height ${vv?.height ?? '-'} off ${vv?.offsetTop ?? '-'}`,
      `screen.height ${screen.height}`,
      `clientHeight ${document.documentElement.clientHeight}`,
      `100dvh ${cs.height}`,
      `safe top ${cs.paddingTop} bottom ${cs.paddingBottom}`,
      `--lines-viewport ${shell.getBoundingClientRect().height}`,
      `--lines-keyboard ${root.getPropertyValue('--lines-keyboard')}`,
    ].join('\n');
  };
  render();
  window.addEventListener('resize', render);
  window.visualViewport?.addEventListener('resize', render);
  window.visualViewport?.addEventListener('scroll', render);
}
