import { WorkerBanner } from '../../web/src/components/WorkerBanner';
import { withHeaderBar, withSessionStore } from '../decorators';

// The orange pill: the bridge cannot reach the agent worker that runs the CLIs.
export default {
  component: WorkerBanner,
  title: 'Shell/Banners/WorkerBanner',
  argTypes: {
    headerHeight: { type: 'number' },
  },
  args: { headerHeight: 56 },
  decorators: [withHeaderBar, withSessionStore],
  parameters: { store: { workerStatus: { connected: false, since: Date.UTC(2026, 9, 12, 9, 41) } } },
};

export const NotResponding = {};
export const VersionMismatch = {
  parameters: { store: { workerStatus: { connected: false, mismatch: { worker: 5, bridge: 6 } } } },
};
