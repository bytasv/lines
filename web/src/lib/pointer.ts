/**
 * Whether a hover-revealed control should be visible.
 *
 * Six places gate an action on a React `hovered` boolean feeding inline
 * `opacity` and `pointerEvents`. On a touchscreen `hovered` is never true, so
 * those actions — delete a session, rewind a turn, edit a queued prompt — simply
 * do not exist. A CSS `@media (hover: none)` override cannot fix it: these are
 * inline styles, and inline wins.
 *
 * So the rule moves into one pure function every site calls. On a coarse pointer
 * everything is shown outright; with a mouse the behaviour is exactly what it
 * was. Pure so it can be tested without a DOM.
 */
export function revealActions(hovered: boolean, coarse: boolean): boolean {
  return coarse || hovered;
}

/*
 * Nothing is imported here, deliberately. A `node:test` imports this function —
 * the repo has no browser test runner — so a single import of `@mantine/hooks`
 * (or of `./layout`, which uses `matchMedia`) would pull a browser runtime into
 * a node process at module load. The hook that consumes this lives in
 * `./layout.ts`, where browser globals belong.
 */
