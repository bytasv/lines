import { SessionView } from '../../web/src/components/SessionView';
import { withMainArea, withSessionStore } from '../decorators';
import {
  DEVICE_ID,
  MACHINE_SLICE,
  SESSION_CODEX,
  SESSION_EMPTY,
  SESSION_FAILED,
  SESSION_IDLE,
  SESSION_QUEUED,
  SESSION_RUNNING,
  SESSION_WAITING,
  SESSION_WORKFLOW,
} from '../fixtures';

// The main area with a session open: its header (path, name, who else is here,
// share and diff actions, machine dot), the workflow stepper when it runs one,
// the transcript, the queue rows and the composer.
export default {
  component: SessionView,
  title: 'Shell/SessionView',
  argTypes: {
    sessionId: { type: 'string' },
  },
  args: {
    sessionId: SESSION_IDLE.id,
  },
  decorators: [withMainArea, withSessionStore],
};

/** Grace and Linus are in this one too. */
export const Idle = {};
export const Running = { args: { sessionId: SESSION_RUNNING.id } };
export const WaitingPermission = { args: { sessionId: SESSION_WAITING.id } };
export const FailedTurn = { args: { sessionId: SESSION_FAILED.id } };
export const WorkflowRun = { args: { sessionId: SESSION_WORKFLOW.id } };
export const Queued = { args: { sessionId: SESSION_QUEUED.id } };
export const NewSession = { args: { sessionId: SESSION_EMPTY.id } };
export const Codex = { args: { sessionId: SESSION_CODEX.id } };
export const MachineOffline = {
  parameters: {
    store: { machines: { [DEVICE_ID]: { ...MACHINE_SLICE, machineOffline: true } } },
  },
};
