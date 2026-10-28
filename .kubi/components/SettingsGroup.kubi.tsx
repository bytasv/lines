import { Switch } from '@mantine/core';
import { SettingsGroup, SettingsRow } from '../../web/src/components/SettingsLayout';

export default {
  component: SettingsGroup,
  title: 'Settings/SettingsGroup',
  argTypes: {
    title: { type: 'string' },
    footer: { type: 'string' },
    children: { type: 'slot' },
  },
  args: {
    title: 'Notifications',
    footer: 'Alerts only fire while this browser has the tab open or push is enabled.',
    children: (
      <>
        <SettingsRow
          label="Sound on finish"
          description="Play a chime when a turn completes."
          control={<Switch size="sm" defaultChecked />}
        />
        <SettingsRow
          label="Needs-you alerts"
          description="Notify when the agent asks a question or needs approval."
          control={<Switch size="sm" />}
        />
      </>
    ),
  },
  slots: ['children'],
};

export const Default = {};
export const Untitled = { args: { title: undefined, footer: undefined } };
