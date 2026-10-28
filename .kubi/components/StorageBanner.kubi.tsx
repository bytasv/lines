import { StorageBanner } from '../../web/src/components/StorageBanner';
import { withHeaderBar, withSessionStore } from '../decorators';

// The amber pill: cloud sync is paused, local work goes on. Retry and dismiss
// are live; the text opens Settings → Diagnostics.
const fourMinutesAgo = Date.now() - 4 * 60_000;

export default {
  component: StorageBanner,
  title: 'Shell/Banners/StorageBanner',
  argTypes: {
    headerHeight: { type: 'number' },
  },
  args: { headerHeight: 56 },
  decorators: [withHeaderBar, withSessionStore],
  parameters: {
    store: {
      storageStatus: {
        available: false,
        kind: 'network',
        reason: 'fetch failed: connect ECONNREFUSED storage.lines.dev:443',
        since: fourMinutesAgo,
        failures: 6,
      },
    },
  },
};

export const Unreachable = {};
export const Reauthenticating = {
  parameters: {
    store: {
      storageStatus: { available: false, kind: 'auth', reason: 'token expired', since: fourMinutesAgo, failures: 1 },
    },
  },
};
