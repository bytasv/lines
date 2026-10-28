import { SettingsSwitchRow } from '../../web/src/components/SettingsLayout';

export default {
  component: SettingsSwitchRow,
  title: 'Settings/SettingsSwitchRow',
  argTypes: {
    label: { type: 'string' },
    description: { type: 'string' },
    checked: { type: 'boolean' },
    disabled: { type: 'boolean' },
    onChange: { action: 'changed' },
  },
  args: {
    label: 'Push notifications',
    description: 'Alert this device when a session needs you.',
    checked: true,
    disabled: false,
  },
  decorators: [(Story: React.ComponentType) => <div style={{ maxWidth: 560 }}><Story /></div>],
};

export const On = {};
export const Off = { args: { checked: false } };
export const Disabled = { args: { disabled: true, description: 'This browser does not support push.' } };
