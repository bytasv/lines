import { diagSource } from './diag';

/** Modifier label for the shortcut hints: ⌘ on Apple platforms, Ctrl elsewhere. */
export const MOD =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

/**
 * Running in the desktop shell's own window rather than a browser tab. A function,
 * not a constant: main.tsx records the window kind after every import has run.
 */
export const isDesktop = (): boolean => diagSource() === 'desktop-window';

/**
 * The new-session shortcut, as a `useHotkeys` key and its hint label. Browsers
 * reserve Cmd/Ctrl+N for a new window, so a tab falls back to Shift+O.
 */
export function newSessionHotkey(): { key: string; label: string } {
  return isDesktop() ? { key: 'mod+N', label: `${MOD}N` } : { key: 'mod+shift+O', label: `${MOD}⇧O` };
}
