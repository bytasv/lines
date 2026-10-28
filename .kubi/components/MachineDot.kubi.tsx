import { MachineDot } from '../../web/src/components/MachineDot';

export default {
  component: MachineDot,
  title: 'Status/MachineDot',
  argTypes: {
    health: { type: 'object' },
  },
  args: {
    health: { state: 'online', color: 'green', label: 'online', block: null },
  },
};

export const Online = {};
export const Degraded = {
  args: { health: { state: 'degraded', color: 'orange', label: 'worker not responding', block: null } },
};
export const Offline = {
  args: { health: { state: 'offline', color: 'red', label: 'offline', block: null } },
};
export const Unknown = {
  args: { health: { state: 'unknown', color: 'gray', label: 'seen 3h ago', block: null } },
};
