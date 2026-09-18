import { useMediaQuery } from '@mantine/hooks';
import { revealActions } from './pointer';

/**
 * Which shape the app is being driven in.
 *
 * Deliberately its own module rather than a field on `machines.ts`: a server-side
 * `node:test` imports that file, so it has to stay free of `matchMedia` and of
 * anything else that only exists in a browser. Keeping the two apart is what
 * stops a merge-rule test from failing on a missing DOM global.
 *
 * Mantine's default breakpoints, not custom ones. `sm` is 48em/768px, so
 * "phone" here means everything below a tablet in portrait — which is the line
 * the layout actually cares about.
 */
export function useIsPhone(): boolean {
  // `false` as the initial value, because the first render happens before the
  // query resolves: a desktop layout that reflows once is a flicker, whereas a
  // phone layout that appears briefly on a desktop is a bug report.
  return useMediaQuery('(max-width: 48em)', false) ?? false;
}

/**
 * Whether the primary pointer is a finger rather than a mouse.
 *
 * Distinct from {@link useIsPhone} on purpose: a touchscreen laptop is coarse
 * but not narrow, and an iPad is neither phone-width in landscape nor
 * mouse-driven. Layout keys off width; anything that depends on *hover existing*
 * keys off this.
 */
export function useIsCoarse(): boolean {
  return useMediaQuery('(pointer: coarse)', false) ?? false;
}

/**
 * The hook in front of {@link revealActions}. Lives here rather than beside the
 * pure function so that function stays importable from a node test.
 */
export function useReveal(hovered: boolean): boolean {
  return revealActions(hovered, useIsCoarse());
}
