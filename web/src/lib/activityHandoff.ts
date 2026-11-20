import type { Icon } from '@tabler/icons-react';

/**
 * What the activity row ("Thinking…") is showing, per session, so the checklist
 * row that replaces it can start on exactly that text and glyph and crossfade
 * from them (TurnChecklist). The two are different components in different
 * parents, so the hand-off goes through here.
 */
export interface ActivityHandoff {
  label: string;
  /** Plain text after the label, e.g. ` · 12s`. */
  suffix: string;
  glyph: Icon;
}

const shown = new Map<string, ActivityHandoff>();

/** The activity row's text as of its latest commit. */
export function recordActivity(sessionId: string, handoff: ActivityHandoff): void {
  shown.set(sessionId, handoff);
}

/** The activity row is gone; there is nothing to hand off any more. */
export function clearActivity(sessionId: string): void {
  shown.delete(sessionId);
}

/**
 * What the activity row was showing, if it is still on screen. Read while the
 * replacing row renders: the activity row's unmount clean-up only runs after
 * that render, so a record here means it was visible in the previous frame.
 */
export function activityOnScreen(sessionId: string): ActivityHandoff | null {
  return shown.get(sessionId) ?? null;
}
