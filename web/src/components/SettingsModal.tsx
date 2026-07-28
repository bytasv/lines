import { ActionIcon, Button, Group, Modal, SegmentedControl, Select, Stack, Switch, Text, Tooltip } from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons-react';
import type { PermissionMode } from '@lines/shared';
import { useStore, type CompactionLevel } from '../store';
import { ALERT_SOUND_OPTIONS } from '../lib/alerts';
import { GuardAllowlistSection } from './GuardAllowlistSection';
import { modelSelectData, renderModelOption } from '../lib/modelSelect';
import { PERMISSION_MODE_SEGMENTS } from '../lib/permissionModes';
import { send } from '../ws';

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
  const compactionLevel = useStore((s) => s.compactionLevel);
  const setCompactionLevel = useStore((s) => s.setCompactionLevel);
  const turnSummariesEnabled = useStore((s) => s.turnSummariesEnabled);
  const setTurnSummariesEnabled = useStore((s) => s.setTurnSummariesEnabled);
  const autoContinueInterrupted = useStore((s) => s.autoContinueInterrupted);
  const setAutoContinueInterrupted = useStore((s) => s.setAutoContinueInterrupted);
  const auth = useStore((s) => s.auth);
  const openLoginModal = useStore((s) => s.openLoginModal);
  const openGuardReview = useStore((s) => s.openGuardReview);

  const alertsDescription =
    alertsEnabled && notifyPermission !== 'granted'
      ? 'Sound only — notifications blocked in browser settings'
      : 'Chime and desktop notification when a session finishes or needs input';

  return (
    // md, not sm: allowlisted Bash prefixes truncate at the narrower width.
    <Modal opened={opened} onClose={onClose} title="Settings" size="md" centered>
      <Stack gap="xs">
        <Text size="xs" fw={600} c="dimmed" tt="uppercase">
          Account
        </Text>
        {auth?.loggedIn ? (
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm" truncate>
              {auth.account?.email ?? 'Signed in'}
              {auth.account?.organization ? ` · ${auth.account.organization}` : ''}
            </Text>
            <Button size="xs" variant="default" onClick={() => send({ type: 'authLogout' })}>
              Log out
            </Button>
          </Group>
        ) : (
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm" c="dimmed">
              Not signed in to Claude
            </Text>
            <Button
              size="xs"
              onClick={() => {
                onClose();
                openLoginModal();
              }}
            >
              Sign in…
            </Button>
          </Group>
        )}
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" mt="sm">
          New session defaults
        </Text>
        <Select
          label="Model"
          data={modelSelectData(models, defaults.model)}
          renderOption={renderModelOption}
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
            data={PERMISSION_MODE_SEGMENTS}
            value={defaults.permissionMode}
            onChange={(v) => setDefaults({ ...defaults, permissionMode: v as PermissionMode })}
          />
        </Stack>
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" mt="sm">
          Transcript
        </Text>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Compaction
          </Text>
          <SegmentedControl
            size="xs"
            data={[
              { value: 'full', label: 'Full' },
              { value: 'grouped', label: 'Grouped' },
              { value: 'compact', label: 'Compact' },
            ]}
            value={compactionLevel}
            onChange={(v) => setCompactionLevel(v as CompactionLevel)}
          />
        </Stack>
        <Switch
          checked={turnSummariesEnabled}
          onChange={(e) => setTurnSummariesEnabled(e.currentTarget.checked)}
          label="AI turn summaries"
          description="Summarize each turn's actions in a sentence; off shows the agent's own narration instead"
        />
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" mt="sm">
          Recovery
        </Text>
        <Switch
          checked={autoContinueInterrupted}
          onChange={(e) => setAutoContinueInterrupted(e.currentTarget.checked)}
          label="Auto-continue interrupted turns"
          description="Resume a turn that died with the app instead of waiting for the Continue button"
        />
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
        <GuardAllowlistSection
          onOpenReview={() => {
            onClose();
            openGuardReview();
          }}
        />
      </Stack>
    </Modal>
  );
}
