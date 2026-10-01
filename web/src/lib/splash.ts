import { useLayoutEffect, useSyncExternalStore } from 'react';

/**
 * The boot splash: `#lines-splash` in index.html. The HTML paints it before any
 * script runs, and it stays that same element until something the user has to
 * see takes over. React never re-renders it, so the loop that starts at first
 * paint runs straight through every boot step. Only the caption changes.
 *
 * A screen holds the splash with `useSplash` while it waits. Once nothing holds
 * it, the mark finishes drawing and the splash fades out over whatever rendered
 * beneath: the landing page, or a gate that needs input.
 *
 * The app is handed over differently (`awaitApp`). Rendering it is the heaviest
 * thing boot does, and doing that under the running loop stalled both the loop
 * and the fade. So the app mounts only once the mark has finished and stands
 * still, kept out of sight; the splash fades once the app has painted, and the
 * app fades in the moment the splash is gone.
 *
 * A later claim (switching machines from inside the app) brings the splash back.
 */

const root = document.getElementById('lines-splash');
const caption = document.getElementById('lines-splash-caption');
const slot = document.getElementById('lines-splash-slot');
const appRoot = document.getElementById('root');

/**
 * index.html hid the splash before first paint: a landing route, or a visitor
 * with no signed-in Clerk cookie. Read at module load, before any claim can
 * change it.
 */
export const splashSkippedAtBoot = root?.dataset.state === 'hidden';

/**
 * `finishing`: the mark is settling onto the finished logo. `finished`: it has,
 * and the splash is waiting for the app to mount under it.
 */
export type SplashState = 'shown' | 'finishing' | 'finished' | 'leaving' | 'hidden';

/** Live claims in mount order. The newest one's caption is shown. */
const claims = new Map<symbol, string>();
let settleFrame = 0;
let hideTimer = 0;
let appTimer = 0;
/** Bumped whenever a leave starts or the splash is shown again, so a stale step knows to stop. */
let leaveRun = 0;
/** The mark's settle onto the finished logo, while a leave is running it. */
let settling: Animation[] = [];
/** The app ready to take over and not yet mounted, by token; 0 for none. */
let appExpected = 0;
let appTokens = 0;
/** The fade under way ends by fading the app in. */
let revealOnHide = false;
const listeners = new Set<() => void>();

/** How long each part of the mark takes to settle, and the step between parts in reading order. */
const MARK_SETTLE_MS = 400;
const MARK_STAGGER_MS = 25;
/** The finished mark, held still for a beat before it fades. */
const MARK_HOLD_MS = 120;
/** Upper bound on the fade in loader.css (550ms), for when `transitionend` never fires. */
const LEAVE_FALLBACK_MS = 1000;
/** How long the finished mark waits for an app that said it was coming. */
const APP_MOUNT_FALLBACK_MS = 4000;
/** The app's own fade-in, once the splash has gone. */
const APP_FADE_MS = 500;

function setState(state: SplashState) {
  if (!root || root.dataset.state === state) return;
  root.dataset.state = state;
  for (const listener of listeners) listener();
}

function show(text: string) {
  cancelAnimationFrame(settleFrame);
  settleFrame = 0;
  clearTimeout(hideTimer);
  clearTimeout(appTimer);
  if (!root || !caption) return;
  if (root.dataset.state !== 'shown') {
    leaveRun++;
    restartMark();
    revealOnHide = false;
    appRoot?.style.removeProperty('opacity');
  }
  setState('shown');
  if (caption.textContent === text) return;
  caption.textContent = text;
  // Replay the caption's fade, so a new step reads as progress rather than a swap.
  for (const animation of caption.getAnimations()) animation.currentTime = 0;
}

/** What the properties the loop animates are right now, for one part of the mark. */
function pose(el: Element): Keyframe {
  const style = getComputedStyle(el);
  return { opacity: style.opacity, transform: style.transform, strokeDashoffset: style.strokeDashoffset };
}

/**
 * Bring the mark from wherever its loop is onto the finished logo: every bracket
 * drawn, every line typed, the comet gone. The loop has no end of its own, and
 * fading it out as it was cut it off mid-stroke.
 *
 * The finished logo is each part's resting style, which is what stopping its
 * loop leaves behind, so this only animates from the pose the loop was in.
 */
function completeMark(): Promise<unknown> {
  if (!root || matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
  const parts = Array.from(root.querySelectorAll<SVGElement>('.lines-loader-anim'));
  // Every part read mid-loop before any is stopped: a stopped part reads its rest.
  const from = parts.map(pose);
  for (const el of parts) el.style.animation = 'none';
  settling = parts.map((el, n) =>
    el.animate(
      // The comet fades where it is, rather than sliding back to its start.
      [from[n], el.classList.contains('lines-loader-comet') ? { ...from[n], opacity: '0' } : pose(el)],
      {
        duration: MARK_SETTLE_MS,
        delay: (Number(el.style.getPropertyValue('--i')) || 0) * MARK_STAGGER_MS,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'forwards',
      },
    ),
  );
  return Promise.all(settling.map((animation) => animation.finished));
}

/** Undo completeMark: back to the loop, from its start. */
function restartMark() {
  for (const animation of settling) animation.cancel();
  settling = [];
  root?.querySelectorAll<SVGElement>('.lines-loader-anim').forEach((el) => el.style.removeProperty('animation'));
}

function fadeIn(el: HTMLElement) {
  el.style.removeProperty('opacity');
  // Eases out: it picks up where the splash's ease-in fade left off (loader.css).
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: APP_FADE_MS, easing: 'cubic-bezier(0, 0, 0.2, 1)' });
}

function hide() {
  if (root?.dataset.state !== 'leaving') return;
  setState('hidden');
  if (revealOnHide && appRoot) fadeIn(appRoot);
  revealOnHide = false;
}

function fadeOut(revealApp: boolean) {
  clearTimeout(appTimer);
  if (root?.dataset.state !== 'finishing' && root?.dataset.state !== 'finished') return;
  revealOnHide = revealApp;
  setState('leaving');
  hideTimer = window.setTimeout(hide, LEAVE_FALLBACK_MS);
}

function leave() {
  if (!root || root.dataset.state !== 'shown') return;
  const run = ++leaveRun;
  setState('finishing');
  void completeMark()
    // Cancelled because the splash was shown again; `run` below says so.
    .catch(() => undefined)
    .then(() => {
      if (run !== leaveRun) return;
      if (appExpected) {
        // The app mounts under the finished mark, out of sight until the splash
        // has gone; appMounted() starts the fade.
        appRoot?.style.setProperty('opacity', '0');
        setState('finished');
        appTimer = window.setTimeout(() => fadeOut(true), APP_MOUNT_FALLBACK_MS);
        return;
      }
      setTimeout(() => {
        if (run === leaveRun) fadeOut(false);
      }, MARK_HOLD_MS);
    });
}

root?.addEventListener('transitionend', (event) => {
  if (event.target === root && event.propertyName === 'opacity') hide();
});

function settle() {
  const newest = Array.from(claims.values()).pop();
  if (newest !== undefined) {
    show(newest);
    return;
  }
  if (settleFrame) return;
  // Two frames before letting go. One step handing over to the next releases and
  // re-claims within a single commit, and whatever rendered beneath should have
  // painted before the fade starts revealing it.
  settleFrame = requestAnimationFrame(() => {
    settleFrame = requestAnimationFrame(() => {
      settleFrame = 0;
      if (claims.size === 0) leave();
    });
  });
}

/**
 * Called once after the first commit. It lets the splash go when no screen
 * claimed it: the landing page, /welcome, /join.
 */
export function settleSplash() {
  settle();
}

/**
 * Holds the splash up with `text` as its caption while mounted. `null` holds
 * nothing. Returns the slot under the caption, for a portal, while claiming.
 *
 * A layout effect, not a passive one: the claim has to land in the same commit
 * that unmounts the previous step, or the splash starts leaving in between.
 */
export function useSplash(text: string | null): HTMLElement | null {
  useLayoutEffect(() => {
    if (text === null) return;
    const key = Symbol(text);
    claims.set(key, text);
    settle();
    return () => {
      claims.delete(key);
      settle();
    };
  }, [text]);
  return text === null ? null : slot;
}

/** A boot step with nothing to show but its caption. */
export function SplashStep({ caption: text }: { caption: string }) {
  useSplash(text);
  return null;
}

/**
 * An app is ready to take over. Called in the same commit that releases its
 * claim, so the leave that follows knows to stop at `finished` and wait for
 * `appMounted` instead of fading over an empty page. The disposer withdraws an
 * app that unmounts before it ever rendered, and the splash then leaves as it
 * would for any other screen.
 */
export function awaitApp(): () => void {
  const token = ++appTokens;
  appExpected = token;
  return () => {
    if (appExpected !== token) return;
    appExpected = 0;
    if (root?.dataset.state === 'finished') {
      appRoot?.style.removeProperty('opacity');
      fadeOut(false);
    }
  };
}

/**
 * The app has committed under the finished mark. Two frames for its first paint
 * and whatever its mount set off, then the splash fades, and the app fades in the
 * moment the splash is gone.
 */
export function appMounted() {
  appExpected = 0;
  if (!root || root.dataset.state === 'hidden') {
    if (appRoot) fadeIn(appRoot);
    return;
  }
  if (root.dataset.state !== 'finished') return;
  const run = leaveRun;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (run === leaveRun) fadeOut(true);
    }),
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function currentState(): SplashState {
  return (root?.dataset.state as SplashState | undefined) ?? 'hidden';
}

/** Where the splash is in its hand-over; `hidden` when there is no splash at all. */
export function useSplashState(): SplashState {
  return useSyncExternalStore(subscribe, currentState);
}
