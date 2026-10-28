import { Button, Select, Switch } from '@mantine/core';
import { SettingsRow } from '../../web/src/components/SettingsLayout';

export default {
  component: SettingsRow,
  title: 'Settings/SettingsRow',
  argTypes: {
    label: { type: 'string' },
    description: { type: 'string' },
    controlWidth: { type: 'number' },
    htmlFor: { type: 'string' },
    control: { type: 'slot' },
    leftSection: { type: 'slot' },
    children: { type: 'slot' },
  },
  args: {
    label: 'Default model',
    description: 'Used for new sessions unless a project overrides it.',
    controlWidth: 220,
    control: (
      <Select
        data={['Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 4.5']}
        defaultValue="Claude Opus 5.5"
        allowDeselect={false}
      />
    ),
  },
  slots: ['control', 'leftSection', 'children'],
  decorators: [(Story: React.ComponentType) => <div style={{ maxWidth: 560 }}><Story /></div>],
};

export const WithSelect = {};
export const WithSwitch = {
  args: {
    label: 'Keep screen awake',
    description: 'While a turn is running on this device.',
    controlWidth: undefined,
    control: <Switch size="sm" defaultChecked />,
  },
};
export const WithButton = {
  args: {
    label: 'Sign out everywhere',
    description: 'Ends every browser session for this account.',
    controlWidth: undefined,
    control: <Button variant="default" color="red">Sign out</Button>,
  },
};
