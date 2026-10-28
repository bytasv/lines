import { Transcript } from '../../web/src/components/Transcript';
import { withSessionStore, withTranscriptPane } from '../decorators';
import {
  CONVERSATION_EVENTS,
  FAILED_EVENTS,
  RUNNING_EVENTS,
  SESSION_EMPTY,
  SESSION_FAILED,
  SESSION_IDLE,
  SESSION_RUNNING,
  SESSION_WAITING,
  WAITING_EVENTS,
} from '../fixtures';

export default {
  component: Transcript,
  title: 'Transcript/Transcript',
  argTypes: {
    sessionId: { type: 'string' },
    events: { type: 'array' },
    stepCount: { type: 'number' },
  },
  args: {
    sessionId: SESSION_IDLE.id,
    events: CONVERSATION_EVENTS,
  },
  decorators: [withTranscriptPane, withSessionStore],
};

export const Conversation = {};
export const Running = { args: { sessionId: SESSION_RUNNING.id, events: RUNNING_EVENTS } };
export const WaitingPermission = { args: { sessionId: SESSION_WAITING.id, events: WAITING_EVENTS } };
export const FailedTurn = { args: { sessionId: SESSION_FAILED.id, events: FAILED_EVENTS } };
export const Empty = { args: { sessionId: SESSION_EMPTY.id, events: [] } };
