import { Composer } from '../../web/src/components/Composer';
import { withComposerColumn, withSessionStore } from '../decorators';
import {
  SESSION_CODEX,
  SESSION_EMPTY,
  SESSION_IDLE,
  SESSION_RUNNING,
  SESSION_WAITING,
} from '../fixtures';

export default {
  component: Composer,
  title: 'Composer/Composer',
  argTypes: {
    session: { type: 'object' },
  },
  args: {
    session: SESSION_IDLE,
  },
  decorators: [withComposerColumn, withSessionStore],
};

export const Idle = {};
export const Running = { args: { session: SESSION_RUNNING } };
export const WaitingPermission = { args: { session: SESSION_WAITING } };
export const NewSession = { args: { session: SESSION_EMPTY } };
export const Codex = { args: { session: SESSION_CODEX } };
