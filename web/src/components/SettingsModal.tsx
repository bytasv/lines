import { ActionIcon, Group, Modal, SegmentedControl, Select, Stack, Switch, Text, Tooltip } from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons-react';
import type { PermissionMode } from '@claude-ui/shared';
import { useStore } from '../store';
import { ALERT_SOUND_OPTIONS } from '../lib/alerts';
import { MODE_LABELS } from './Composer';

export function SettingsModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const models = useStore((s) => s.models);
  const defaults = useStore((s) => s.newSessionDefaults);
  const setDefaults = useStore((s) => s.setNewSessionDefaults);
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

  return (
    <Modal opened={opened} onClose={onClose} title="Settings" size="sm" centered>
      <Stack gap="xs">
        <Text size="xs" fw={600} c="dimmed" tt="uppercase">
          New session defaults
        </Text>
        <Select
          label="Model"
          data={models.map((m) => ({ value: m.id, label: m.label }))}
          value={defaults.model}
          onChange={(v) => v && setDefaults({ ...defaults, model: v })}
          allowDeselect={false}
        />
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Permission mode
          </Text>
          <SegmentedControl
            size="xs"
            data={MODE_LABELS}
            value={defaults.permissionMode}
            onChange={(v) => setDefaults({ ...defaults, permissionMode: v as PermissionMode })}
          />
        </Stack>
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" mt="sm">
          Notifications
        </Text>
        <Switch
          checked={alertsEnabled}
          onChange={(e) => void setAlertsEnabled(e.currentTarget.checked)}
          label="Alerts"
          description={alertsDescription}
        />
        <Group gap="xs" align="flex-end" wrap="nowrap">
          <Select
            label="Sound"
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
      </Stack>
    </Modal>
  );
}
