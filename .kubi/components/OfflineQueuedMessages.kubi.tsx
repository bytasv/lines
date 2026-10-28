import { OfflineQueuedMessages } from '../../web/src/components/QueuedMessages';
import { withComposerColumn, withSessionStore } from '../decorators';
import { SESSION_OFFLINE } from '../fixtures';

// The rows come from the store's `queuedPrompts` (seeded in decorators.tsx),
// filtered to this session.
export default {
  component: OfflineQueuedMessages,
  title: 'Composer/OfflineQueuedMessages',
  argTypes: {
    session: { type: 'object' },
  },
  args: {
    session: SESSION_OFFLINE,
  },
  decorators: [withComposerColumn, withSessionStore],
};

export const NotSent = {};
