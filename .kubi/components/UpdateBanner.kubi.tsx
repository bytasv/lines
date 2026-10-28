import { UpdateBanner } from '../../web/src/components/UpdateBanner';
import { withHeaderBar, withSessionStore } from '../decorators';
import { SESSION_RUNNING, SESSION_WORKFLOW } from '../fixtures';

// The indigo pill: the desktop app downloaded a new release and can restart
// into it — or refuses to while sessions are running, and names them.
// (The "available, download it" shape needs a download URL baked into the
// build, which development builds — and so Kubi's islands — do not have.)
export default {
  component: UpdateBanner,
  title: 'Shell/Banners/UpdateBanner',
  argTypes: {
    headerHeight: { type: 'number' },
  },
  args: { headerHeight: 56 },
  decorators: [withHeaderBar, withSessionStore],
  parameters: { store: { updateStatus: { state: 'ready', version: '0.1.25' } } },
};

export const ReadyToRestart = {};
export const BlockedByOneSession = {
  parameters: {
    store: {
      updateStatus: {
        state: 'ready',
        version: '0.1.25',
        restartBlocked: true,
        restartBlockers: [{ id: SESSION_RUNNING.id, title: SESSION_RUNNING.name }],
      },
    },
  },
};
export const BlockedBySeveral = {
  parameters: {
    store: {
      updateStatus: {
        state: 'ready',
        version: '0.1.25',
        restartBlocked: true,
        restartBlockers: [
          { id: SESSION_RUNNING.id, title: SESSION_RUNNING.name },
          { id: SESSION_WORKFLOW.id, title: SESSION_WORKFLOW.name },
        ],
      },
    },
  },
};
