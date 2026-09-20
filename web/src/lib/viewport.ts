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
