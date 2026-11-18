import { createContext } from 'react';

/**
 * Keep one element of a transcript row still on screen across that row's own
 * height change — a UI proposal switching between Focus and Compare, say.
 *
 * Call it right before the change, then call what it returns from a layout
 * effect once the change has committed. If the row moved or the transcript's
 * height changed, the view is shifted by however far the element moved, and
 * following the stream stands down: otherwise the transcript's resize observer
 * would pull the view to the bottom under the reader. A change that moved
 * nothing leaves both alone.
 */
export type KeepInView = (el: HTMLElement) => () => void;

/** Provided by Transcript; null outside one, where callers just skip anchoring. */
export const TranscriptAnchorContext = createContext<KeepInView | null>(null);
