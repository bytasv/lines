import { IconBooks, IconMoon, IconSettings } from '@tabler/icons-react';
import { UserMenu } from '../../web/src/components/UserMenu';

// Clerk's avatar button (a stand-in here — see mocks/clerk) with the app's own
// items appended to its menu: Documentation on a desktop, theme and Settings
// too on a phone, where the header has no room for them.
export default {
  component: UserMenu,
  title: 'Shell/UserMenu',
  argTypes: {
    actions: { type: 'array' },
  },
  args: {
    actions: [{ label: 'Documentation', icon: <IconBooks size={14} />, onClick: () => {} }],
  },
};

export const Desktop = {};
export const Phone = {
  args: {
    actions: [
      { label: 'Documentation', icon: <IconBooks size={14} />, onClick: () => {} },
      { label: 'Light mode', icon: <IconMoon size={14} />, onClick: () => {} },
      { label: 'Settings', icon: <IconSettings size={14} />, onClick: () => {} },
    ],
  },
};
export const NoActions = { args: { actions: [] } };
