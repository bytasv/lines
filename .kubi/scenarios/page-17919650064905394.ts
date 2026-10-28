import type { TranscriptEvent } from '@lines/shared';
import * as earlier from './page-17919581889488394';
import avatar from './page-17919650064905394/images/ProjectTabs-Frame-17919650064815156-2.jpg';
import promptAvatar from './page-17919650064905394/images/SessionView-Frame-17919650064765015-1.jpg';

// The same "Lines" page as page-17919581889488394, captured again a little
// later: the same plan-mode session waiting on its question, the same sidebar.
// Only the Claude 5-hour window moved, to 14%. Built from that scenario so the
// two stay in step, with this capture's own images.

const NOW = Date.UTC(2026, 9, 14, 12, 0);
const HOUR = 3_600_000;

type UserData = { actor?: { imageUrl?: string } };

/** The open session's transcript, its prompt carrying this capture's photo. */
const VIEW_EVENTS: TranscriptEvent[] = earlier.VIEW_EVENTS.map((e) => {
  const data = e.data as UserData;
  if (e.kind !== 'user' || !data.actor) return e;
  return { ...e, data: { ...data, actor: { ...data.actor, imageUrl: promptAvatar } } };
});

const VIEW_ID = Object.keys(earlier.store.transcripts)[0];

export const account = { imageUrl: avatar };

export const layout = earlier.layout;

export const sessionSort = earlier.sessionSort;

export const showArchived = earlier.showArchived;

/** Store fields this page shows differently from the shared fixtures. */
export const store = {
  ...earlier.store,
  transcripts: { [VIEW_ID]: VIEW_EVENTS },
  // The Claude ring read 14 on the page, ChatGPT's still 0.
  usage: {
    windows: [
      { id: 'five_hour', utilization: 14, resetsAt: new Date(NOW + 5 * HOUR).toISOString() },
      { id: 'seven_day', utilization: 0, resetsAt: new Date(NOW + 6 * 24 * HOUR).toISOString() },
    ],
    fetchedAt: NOW,
    plan: 'Max',
  },
};
