import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Indicator,
  Loader,
  Modal,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Tooltip,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconAlertCircle, IconCopy, IconPlayerPlay } from '@tabler/icons-react';
import type { PermissionMode, SyncLogEntry } from '@lines/shared';
import { useStore, type CompactionLevel } from '../store';
import { ALERT_SOUND_OPTIONS } from '../lib/alerts';
import { GuardAllowlistSection } from './GuardAllowlistSection';
import { DevicesSection } from './DevicesSection';
import { DEVICE_PAIRING_ENABLED } from '../lib/storage';
import { modelSelectData, renderModelOption } from '../lib/modelSelect';
import { PERMISSION_MODE_SEGMENTS } from '../lib/permissionModes';
import { fileRequest, send } from '../ws';
import { useIsGuest } from '../lib/can';

export type SettingsSection =
  | 'account'
  | 'devices'
  | 'sessions'
  | 'transcript'
  | 'notifications'
  | 'allowlist'
  | 'diagnostics'
  | 'docs';

const SETTINGS_SECTIONS: { value: SettingsSection; label: string }[] = [
  { value: 'account', label: 'Account' },
  // Only in a hosted build. A local install talks to the bridge on this machine,
  // which is the one and only device — a list of one it cannot revoke is noise.
  ...(DEVICE_PAIRING_ENABLED
    ? [{ value: 'devices' as SettingsSection, label: 'Machines' }]
    : []),
  { value: 'sessions', label: 'Sessions' },
  { value: 'transcript', label: 'Transcript' },
  { value: 'notifications', label: 'Notifications' },
  { value: 'allowlist', label: 'Auto-mode allowlist' },
  { value: 'diagnostics', label: 'Sync' },
  { value: 'docs', label: 'Documentation' },
];

/**
 * Machines is the only pane a guest may see: it lists *their* account's machines
 * and is how they get back to one of their own. Every other pane reads or writes
 * the host's state — settings, the guard allowlist, their Claude account, their
 * sync log — all of which the bridge refuses to a guest anyway.
 */
const GUEST_SECTIONS = SETTINGS_SECTIONS.filter((s) => s.value === 'devices');

export function SettingsModal({
  opened,
  onClose,
  initialSection = 'account',
}: {
  opened: boolean;
  onClose: () => void;
  initialSection?: SettingsSection;
}) {
  const guardReview = useStore((s) => s.guardReview);
  const openGuardReview = useStore((s) => s.openGuardReview);
  const guest = useIsGuest();
  const sections = guest ? GUEST_SECTIONS : SETTINGS_SECTIONS;
  const [section, setSection] = useState<SettingsSection>(initialSection);

  // Snapshot in a ref so a guardReview that clears mid-edit cannot yank the
  // user off the allowlist pane; only an open transition picks the section.
  const initialRef = useRef(initialSection);
  initialRef.current = initialSection;
  useEffect(() => {
    if (opened) setSection(initialRef.current);
  }, [opened]);

  return (
    // Flex-shelled like WorkflowEditor: fixed-height nav rail + scrolling pane.
    <Modal
      opened={opened}
      onClose={onClose}
      title="Settings"
      size="90%"
      centered
      padding={0}
      transitionProps={{ transition: 'fade' }}
      styles={{
        content: { height: '88vh', display: 'flex', flexDirection: 'column' },
        body: { flex: 1, minHeight: 0, display: 'flex', padding: 0 },
        header: { padding: 'var(--mantine-spacing-md)', paddingBottom: 'var(--mantine-spacing-xs)' },
      }}
    >
      <Group align="stretch" gap={0} wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
        <Stack gap="xs" w={200} p="md" style={{ flexShrink: 0 }}>
          {sections.map((s) => {
            const button = (
              <Button
                fullWidth
                variant={s.value === section ? 'light' : 'subtle'}
                color="gray"
                justify="start"
                onClick={() => setSection(s.value)}
              >
                <Text size="xs" truncate>
                  {s.label}
                </Text>
              </Button>
            );
            return (
              <Indicator
                key={s.value}
                size={6}
                color="yellow"
                // Only the allowlist item carries the pending-review dot; the
                // rest wrap a disabled Indicator so the rail stays uniform.
                disabled={s.value !== 'allowlist' || !guardReview}
                offset={2}
                // Block, not Indicator's default inline-block: the wrapped
                // Button has to fill the rail.
                style={{ display: 'block' }}
              >
                {button}
              </Indicator>
            );
          })}
        </Stack>
        <Divider orientation="vertical" />
        <ScrollArea style={{ flex: 1 }} type="hover">
          <Stack gap="xs" p="md" maw={620}>
            {section === 'account' && <AccountSection onClose={onClose} />}
            {section === 'devices' && <DevicesSection />}
            {section === 'sessions' && <SessionsSection />}
            {section === 'transcript' && <TranscriptSection />}
            {section === 'notifications' && <NotificationsSection />}
            {section === 'diagnostics' && <SyncLogSection />}
            {section === 'docs' && <DocsSection onClose={onClose} />}
            {section === 'allowlist' && (
              <GuardAllowlistSection
                onOpenReview={() => {
                  onClose();
                  openGuardReview();
                }}
              />
            )}
          </Stack>
        </ScrollArea>
      </Group>
    </Modal>
  );
}

function AccountSection({ onClose }: { onClose: () => void }) {
  const auth = useStore((s) => s.auth);
  const openLoginModal = useStore((s) => s.openLoginModal);

  return auth?.loggedIn ? (
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
  );
}

/** Hand-off to the documentation reader — close first, like the sign-in and allowlist-review buttons. */
function DocsSection({ onClose }: { onClose: () => void }) {
  const activeProject = useStore((s) => s.activeProject);
  const navigate = useNavigate();

  return (
    <>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase">
        Documentation
      </Text>
      <Text size="sm" c="dimmed">
        Read the active project’s docs/ folder in the app — feature index, doc tree, and full-text
        search.
      </Text>
      <Text size="xs" c="dimmed" ff="monospace" truncate>
        {activeProject ? `${activeProject}/docs` : 'No project open'}
      </Text>
      <Group>
        <Button
          size="xs"
          disabled={!activeProject}
          onClick={() => {
            onClose();
            navigate('/docs');
          }}
        >
          Open documentation
        </Button>
        {!activeProject && (
          <Text size="xs" c="dimmed">
            Open a project first.
          </Text>
        )}
      </Group>
    </>
  );
}

function SessionsSection() {
  const models = useStore((s) => s.models);
  const defaults = useStore((s) => s.newSessionDefaults);
  const setDefaults = useStore((s) => s.setNewSessionDefaults);
  const autoContinueInterrupted = useStore((s) => s.autoContinueInterrupted);
  const setAutoContinueInterrupted = useStore((s) => s.setAutoContinueInterrupted);

  return (
    <>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase">
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
      {/* Global, not a newSessionDefaults member — hence its own subgroup. */}
      <Text size="xs" fw={600} c="dimmed" tt="uppercase" mt="sm">
        Recovery
      </Text>
      <Switch
        checked={autoContinueInterrupted}
        onChange={(e) => setAutoContinueInterrupted(e.currentTarget.checked)}
        label="Auto-continue interrupted turns"
        description="Resume a turn that died with the app instead of waiting for the Continue button"
      />
    </>
  );
}

function TranscriptSection() {
  const compactionLevel = useStore((s) => s.compactionLevel);
  const setCompactionLevel = useStore((s) => s.setCompactionLevel);
  const turnSummariesEnabled = useStore((s) => s.turnSummariesEnabled);
  const setTurnSummariesEnabled = useStore((s) => s.setTurnSummariesEnabled);

  return (
    <>
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
    </>
  );
}

/**
 * Why cloud sync dropped. The bridge writes a row only for a failed storage
 * request or an availability flip, so a healthy install shows an empty list —
 * and a user seeing the amber pill has something concrete to copy into a report
 * (the bridge console isn't reachable on a desktop or VPS install).
 */
function SyncLogSection() {
  // The live status, not the one the route returns beside the rows: it is
  // broadcast on every flip, so this pane can't go stale while it is open.
  const status = useStore((s) => s.storageStatus);
  const [entries, setEntries] = useState<SyncLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clipboard = useClipboard({ timeout: 1500 });

  useEffect(() => {
    let cancelled = false;
    fileRequest('syncLog', {})
      .then(({ status: code, body }) => {
        if (cancelled) return;
        if (code !== 200) {
          setError(`The bridge answered ${code}.`);
          return;
        }
        setEntries((body as { entries?: SyncLogEntry[] })?.entries ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Newest first: an outage is read from its most recent row backwards.
  const rows = entries ? [...entries].reverse() : [];

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Cloud sync keeps your sessions, workflows and steps on the storage server. Local files
        stay the source of truth, so an outage never loses work — these are the failures behind
        the “cloud sync unavailable” notice.
      </Text>

      <Group gap="xs">
        <Badge color={status?.available === false ? 'yellow' : 'green'} variant="light">
          {status?.available === false ? `unavailable${status.kind ? ` · ${status.kind}` : ''}` : 'connected'}
        </Badge>
        {status?.available === false && status.reason && (
          <Text size="xs" c="dimmed" style={{ minWidth: 0 }} truncate>
            {status.reason}
          </Text>
        )}
      </Group>

      {error && (
        <Alert color="red" icon={<IconAlertCircle size={16} />} variant="light">
          {error}
        </Alert>
      )}

      {!entries && !error ? (
        <Group justify="center" p="md">
          <Loader size="sm" />
        </Group>
      ) : rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          No sync failures recorded.
        </Text>
      ) : (
        <>
          <Group>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconCopy size={14} />}
              onClick={() => clipboard.copy(rows.map((e) => JSON.stringify(e)).join('\n'))}
            >
              {clipboard.copied ? 'Copied' : 'Copy log'}
            </Button>
          </Group>
          <Stack gap={4}>
            {rows.map((entry, i) => (
              <Group key={`${entry.at}-${i}`} gap="xs" wrap="nowrap" align="baseline">
                <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                  {new Date(entry.at).toLocaleString()}
                </Text>
                <Badge size="xs" variant="light" color={EVENT_COLOR[entry.event]} style={{ flexShrink: 0 }}>
                  {entry.event}
                </Badge>
                <Text size="xs" style={{ minWidth: 0 }}>
                  {syncLogDetail(entry)}
                </Text>
              </Group>
            ))}
          </Stack>
        </>
      )}
    </Stack>
  );
}

const EVENT_COLOR: Record<SyncLogEntry['event'], string> = {
  fail: 'gray',
  down: 'yellow',
  up: 'green',
};

/** One row as a line: what was tried, what came back, how long it took. */
function syncLogDetail(entry: SyncLogEntry): string {
  const parts: string[] = [];
  if (entry.kind) parts.push(entry.kind);
  if (entry.method && entry.path) parts.push(`${entry.method} ${entry.path}`);
  if (entry.status !== undefined) parts.push(String(entry.status));
  if (entry.ms !== undefined) parts.push(`${entry.ms}ms`);
  if (entry.downMs !== undefined) parts.push(`down ${Math.round(entry.downMs / 1000)}s`);
  if (entry.failures !== undefined) parts.push(`${entry.failures} failed`);
  if (entry.reason) parts.push(entry.reason);
  return parts.join(' · ');
}

function NotificationsSection() {
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
    <>
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
    </>
  );
}
