import { PresenceStack } from '../../web/src/components/PresenceStack';
import { withSessionStore } from '../decorators';
import { GRACE, LINUS, SESSION_IDLE } from '../fixtures';

// Who else is in the session, in its header. Peers only; a ring marks the one
// typing. Renders nothing when you are alone.
const peer = (name: string, i: number, focused = false) => ({
  userId: `user_fixture_peer_${i}`,
  connId: `conn-peer-${i}`,
  profile: { userId: `user_fixture_peer_${i}`, email: null, name, imageUrl: null },
  viewing: true,
  focused,
  lastSeenAt: Date.UTC(2026, 9, 12, 9, 40),
});

export default {
  component: PresenceStack,
  title: 'Shell/PresenceStack',
  argTypes: {
    sessionId: { type: 'string' },
  },
  args: {
    sessionId: SESSION_IDLE.id,
  },
  decorators: [withSessionStore],
};

/** Grace is typing, Linus is reading. */
export const TwoPeers = {};
export const OnePeer = {
  parameters: {
    store: {
      presence: {
        [SESSION_IDLE.id]: [
          { userId: LINUS.userId, connId: 'conn-linus', profile: LINUS, viewing: true, focused: false, lastSeenAt: 0 },
        ],
      },
    },
  },
};
export const Crowded = {
  parameters: {
    store: {
      presence: {
        [SESSION_IDLE.id]: [
          { userId: GRACE.userId, connId: 'conn-grace', profile: GRACE, viewing: true, focused: true, lastSeenAt: 0 },
          { userId: LINUS.userId, connId: 'conn-linus', profile: LINUS, viewing: true, focused: false, lastSeenAt: 0 },
          peer('Margaret Hamilton', 3),
          peer('Ken Thompson', 4),
          peer('Barbara Liskov', 5),
          peer('Dennis Ritchie', 6),
        ],
      },
    },
  },
};
