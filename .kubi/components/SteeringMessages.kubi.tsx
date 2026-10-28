import { SteeringMessages } from '../../web/src/components/QueuedMessages';
import { withComposerColumn, withSessionStore } from '../decorators';
import { ADA, SESSION_STEERING } from '../fixtures';

export default {
  component: SteeringMessages,
  title: 'Composer/SteeringMessages',
  argTypes: {
    session: { type: 'object' },
  },
  args: {
    session: SESSION_STEERING,
  },
  decorators: [withComposerColumn, withSessionStore],
};

export const OneMessage = {};
export const FromCollaborator = {
  args: {
    session: {
      ...SESSION_STEERING,
      steering: [
        ...SESSION_STEERING.steering!,
        { id: 's2', ts: SESSION_STEERING.createdAt + 200_000, text: 'And log each retry at debug level.', actor: ADA },
      ],
    },
  },
};
