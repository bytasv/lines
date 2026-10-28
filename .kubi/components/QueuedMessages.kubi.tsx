import { QueuedMessages } from '../../web/src/components/QueuedMessages';
import { withComposerColumn, withSessionStore } from '../decorators';
import { SESSION_QUEUE_PAUSED, SESSION_QUEUED } from '../fixtures';

export default {
  component: QueuedMessages,
  title: 'Composer/QueuedMessages',
  argTypes: {
    session: { type: 'object' },
  },
  args: {
    session: SESSION_QUEUED,
  },
  decorators: [withComposerColumn, withSessionStore],
};

export const WhileRunning = {};
export const Paused = { args: { session: SESSION_QUEUE_PAUSED } };
