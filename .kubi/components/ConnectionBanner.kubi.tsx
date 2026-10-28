import { ConnectionBanner } from '../../web/src/components/ConnectionBanner';
import { withHeaderBar, withSessionStore } from '../decorators';
import { OFFLINE_PROMPTS } from '../fixtures';

// The red pill centred in the header while the bridge link is down. Every story
// patches the link state for its own instance only (parameters.store), so the
// rest of the canvas stays connected.
export default {
  component: ConnectionBanner,
  title: 'Shell/Banners/ConnectionBanner',
  argTypes: {
    headerHeight: { type: 'number' },
  },
  args: { headerHeight: 56 },
  decorators: [withHeaderBar, withSessionStore],
  parameters: { store: { connectionStatus: 'offline', queuedPrompts: [] } },
};

/** The browser itself is offline. */
export const Offline = {};
export const OfflineWithQueuedMessages = {
  parameters: {
    store: {
      connectionStatus: 'offline',
      queuedPrompts: [
        ...OFFLINE_PROMPTS,
        { id: 'local-2', sessionId: OFFLINE_PROMPTS[0].sessionId, text: 'And bump the changelog.', queuedAt: 0 },
      ],
    },
  },
};
/** A dropped link redialling; the pill waits out a 3 s grace before it shows. */
export const Reconnecting = { parameters: { store: { connectionStatus: 'reconnecting', queuedPrompts: [] } } };
/** The relay is up but no bridge is attached for this machine. */
export const MachineOffline = {
  parameters: { store: { connectionStatus: 'connected', machineOffline: true, queuedPrompts: [] } },
};
