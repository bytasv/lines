import { MachineSwitcher } from '../../web/src/components/MachineSwitcher';
import { withSessionStore } from '../decorators';
import { DEVICE_ID, DEVICE_MINI, MACHINE_SLICE, SESSION_FAILED, SESSION_OTHER_PROJECT, SHELL_STATE } from '../fixtures';

// Icon-only in the header: the current machine's health dot and a chevron; the
// menu lists every paired machine (the fixture devices: this MacBook, an
// offline Mac mini, Grace's shared iMac).
export default {
  component: MachineSwitcher,
  title: 'Shell/MachineSwitcher',
  decorators: [withSessionStore],
};

export const Online = {};

/** The Mac mini is linked too, and two of its sessions need the user: the count badge. */
export const OtherMachineNeedsYou = {
  parameters: {
    store: {
      machines: {
        [DEVICE_ID]: MACHINE_SLICE,
        [DEVICE_MINI]: { ...MACHINE_SLICE, deviceId: DEVICE_MINI, local: false },
      },
      sessionMachine: {
        ...SHELL_STATE.sessionMachine,
        [SESSION_OTHER_PROJECT.id]: DEVICE_MINI,
        [SESSION_FAILED.id]: DEVICE_MINI,
      },
    },
  },
};

export const WorkerDown = {
  parameters: {
    store: {
      machines: { [DEVICE_ID]: { ...MACHINE_SLICE, worker: { connected: false, since: Date.UTC(2026, 9, 12, 9, 41) } } },
    },
  },
};
