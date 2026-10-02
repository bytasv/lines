import { useId } from 'react';
import { ActionIcon, Group, Select, Tooltip } from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons-react';
import { useStore } from '../store';
import { ALERT_SOUND_OPTIONS } from '../lib/alerts';
import { isIos, isStandalone } from '../lib/push';
import { SettingsGroup, SettingsRow, SettingsSwitchRow } from './SettingsLayout';

export function NotificationsSection() {
  const soundId = useId();
  const alertsEnabled = useStore((s) => s.alertsEnabled);
  const notifyPermission = useStore((s) => s.notifyPermission);
  const setAlertsEnabled = useStore((s) => s.setAlertsEnabled);
  const alertSound = useStore((s) => s.alertSound);
  const setAlertSound = useStore((s) => s.setAlertSound);
  const testAlertSound = useStore((s) => s.testAlertSound);

  const alertsDescription =
    alertsEnabled && notifyPermission !== 'granted'
      ? 'Sound only — notifications blocked in browser settings'
      : 'Chime and desktop notification when a session finishes or needs input';
  // iOS only delivers Web Push to the home-screen app, never to a Safari tab.
  const needsHomeScreen = isIos() && !isStandalone();

  return (
    <SettingsGroup
      footer={needsHomeScreen ? 'Add to Home Screen to receive notifications on this device.' : undefined}
    >
      <SettingsSwitchRow
        label="Alerts"
        description={alertsDescription}
        checked={alertsEnabled}
        onChange={(on) => void setAlertsEnabled(on)}
      />
      <SettingsRow
        label="Sound"
        htmlFor={soundId}
        controlWidth={240}
        control={
          <Group gap="xs" wrap="nowrap">
            <Select
              id={soundId}
              size="sm"
              data={ALERT_SOUND_OPTIONS}
              value={alertSound}
              onChange={(v) => v && setAlertSound(v as typeof alertSound)}
              allowDeselect={false}
              style={{ flex: 1 }}
            />
            <Tooltip label="Test sound">
              <ActionIcon
                variant="default"
                size="input-sm"
                aria-label="Test sound"
                onClick={testAlertSound}
              >
                <IconPlayerPlay size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        }
      />
    </SettingsGroup>
  );
}
