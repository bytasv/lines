import { useEffect, useState, type CSSProperties } from 'react';
import { Anchor, Button, Divider, Group, Popover, Stack, Text, UnstyledButton } from '@mantine/core';
import type { SyncLogEntry } from '@lines/shared';
import { formatTimestamp } from '@lines/shared';
import { syncIndicator, useStore } from '../store';
import type { SyncIndicator as SyncReading } from '../store';
import { retryStorage, send } from '../ws';
import { LOCAL_SHELL, returnToCloud } from '../lib/localShell';
import { SettingsModal } from './SettingsModal';
import { SYNC_STATE_LABEL, SyncPendingList, cloudLabel, useSyncLog } from './SyncSection';

/** How long "Syncing…" shows if the bridge's status doesn't change first. */
const SYNC_FEEDBACK_MS = 5_000;
/** Rows of "what will sync when we're back" before the rest is left to Settings. */
const RETRY_ROWS = 6;

const DOT_COLOR: Record<SyncReading['state'], string> = {
  synced: 'green',
  syncing: 'blue',
  pending: 'gray',
  paused: 'gray',
};

/**
 * The header's cloud sync status: a dot, a count while local writes wait for
 * storage, and a popover saying what they are. It replaced the amber "cloud
 * sync unavailable" pill and, in the hosted app, the red transport pill — an
 * outage of the cloud is not something the user has to stop and read about.
 * Work carries on against this machine and syncs when the cloud is back, so
 * nothing here is alarm-coloured, and a state change raises no modal or toast.
 *
 * In the hosted app the link to the machine itself runs through the cloud, so
 * a dropped link (or a machine the relay says is gone) folds in here as a muted
 * dot too. The local window's link is loopback: losing it is a real failure,
 * and ConnectionBanner keeps that one.
 *
 * Hidden for a guest: this status describes somebody else's machine and
 * account, and `syncNow` is owner-only.
 */
export function SyncIndicator() {
  const status = useStore((s) => s.storageStatus);
  const connection = useStore((s) => s.connectionStatus);
  const machineOffline = useStore((s) => s.machineOffline);
  const bootstrapped = useStore((s) => s.bootstrapped);
  const queued = useStore((s) => s.queuedPrompts.length);
  const access = useStore((s) => s.access);
  const [opened, setOpened] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Feedback only, as StorageBanner's Retry was: the dot follows `storageStatus`
  // on its own, and any change to it, or 5s of silence, ends the label.
  useEffect(() => setSyncing(false), [status]);
  useEffect(() => {
    if (!syncing) return;
    const timer = setTimeout(() => setSyncing(false), SYNC_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [syncing]);

  if (access || !bootstrapped || !status) return null;

  const sync = syncIndicator(status);
  // The local window ignores `machineOffline`: it is relay truth, and that
  // window has no relay.
  const linkDown = connection !== 'connected' || (!LOCAL_SHELL && machineOffline);
  const color = linkDown ? 'gray' : DOT_COLOR[sync.state];
  const label = linkDown ? 'Not connected to this machine' : `Cloud sync: ${SYNC_STATE_LABEL[sync.state]}`;

  const syncNow = () => {
    if (!send({ type: 'syncNow' })) return;
    // Out of reach, a fresh token is what makes the bridge probe at once (see
    // retryStorage); `syncNow` alone would only fail against the same outage.
    if (sync.cloud !== 'ok') retryStorage();
    setSyncing(true);
  };

  return (
    <>
      <Popover
        opened={opened}
        onChange={setOpened}
        width="min(320px, calc(100vw - 2rem))"
        position="bottom-end"
        withArrow
        shadow="md"
      >
        <Popover.Target>
          <UnstyledButton
            onClick={() => setOpened((o) => !o)}
            aria-label={label}
            title={label}
            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 2px', flexShrink: 0 }}
          >
            <span
              className="status-dot"
              data-pulse={(!linkDown && sync.state === 'syncing') || undefined}
              style={
                {
                  '--status-dot-color': `var(--mantine-color-${color}-${color === 'gray' ? 5 : 6})`,
                  '--status-pulse-color': `var(--mantine-color-${color}-5)`,
                } as CSSProperties
              }
            />
            {sync.pendingTotal > 0 && (
              <Text size="xs" c="dimmed" lh={1}>
                {sync.pendingTotal}
              </Text>
            )}
          </UnstyledButton>
        </Popover.Target>
        <Popover.Dropdown>
          {linkDown ? (
            <LinkDownBody machineGone={!LOCAL_SHELL && machineOffline && connection === 'connected'} queued={queued} />
          ) : (
            <SyncBody
              sync={sync}
              opened={opened}
              syncing={syncing}
              onSyncNow={syncNow}
              onOpenSettings={() => {
                setOpened(false);
                setSettingsOpen(true);
              }}
            />
          )}
        </Popover.Dropdown>
      </Popover>
      <SettingsModal
        opened={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialSection="diagnostics"
      />
    </>
  );
}

/** Hosted app, link to the machine down: nothing below it is current, so say only that. */
function LinkDownBody({ machineGone, queued }: { machineGone: boolean; queued: number }) {
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        {machineGone ? 'This machine isn’t connected to Lines Cloud' : 'Reconnecting to this machine…'}
      </Text>
      <Text size="xs" c="dimmed">
        {machineGone
          ? 'Lines on it may be closed, or that machine can’t reach the cloud right now.'
          : 'Anything you send waits here and goes out once it’s back.'}
      </Text>
      {queued > 0 && (
        <Text size="xs">
          {queued} message{queued === 1 ? '' : 's'} queued
        </Text>
      )}
    </Stack>
  );
}

function SyncBody({
  sync,
  opened,
  syncing,
  onSyncNow,
  onOpenSettings,
}: {
  sync: SyncReading;
  opened: boolean;
  syncing: boolean;
  onSyncNow: () => void;
  onOpenSettings: () => void;
}) {
  // Only while out of reach: with the cloud up, failed requests are history.
  const { entries } = useSyncLog(opened && sync.cloud !== 'ok');
  const retries = sync.cloud === 'ok' ? [] : awaitingRetry(entries ?? [], sync.since);

  return (
    <Stack gap="xs">
      <div>
        <Text size="sm" fw={500}>
          {cloudLabel(sync)}
        </Text>
        <Text size="xs" c="dimmed">
          {sync.lastSyncedAt ? `Last synced ${formatTimestamp(sync.lastSyncedAt)}` : 'Not synced yet'}
          {sync.cloud !== 'ok' && ' · your work is saved on this machine'}
        </Text>
      </div>

      {sync.pending && (
        <>
          <Divider />
          <Text size="xs" fw={700} tt="uppercase" c="dimmed">
            Waiting to sync
          </Text>
          <SyncPendingList pending={sync.pending} />
        </>
      )}

      {retries.length > 0 && (
        <>
          <Divider />
          <Text size="xs" fw={700} tt="uppercase" c="dimmed">
            Will sync when the cloud is back
          </Text>
          <Stack gap={2}>
            {retries.slice(0, RETRY_ROWS).map((e) => (
              <Text key={`${e.method} ${e.path}`} size="xs" ff="monospace" truncate>
                {e.method} {e.path}
              </Text>
            ))}
            {retries.length > RETRY_ROWS && (
              <Text size="xs" c="dimmed">
                and {retries.length - RETRY_ROWS} more
              </Text>
            )}
          </Stack>
        </>
      )}

      <Divider />
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Anchor component="button" type="button" size="xs" onClick={onOpenSettings}>
          Sync settings
        </Anchor>
        <Group gap="xs" wrap="nowrap">
          {LOCAL_SHELL && sync.cloud === 'ok' && (
            <Button size="xs" variant="light" onClick={returnToCloud}>
              Reconnect to Lines Cloud
            </Button>
          )}
          <Button
            size="xs"
            variant="default"
            // Signed out there is no token to sync with; the button would do nothing.
            disabled={syncing || sync.cloud === 'signedOut'}
            onClick={onSyncNow}
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

/**
 * The writes that failed during this outage, newest first and one per
 * endpoint — what the outbox will send again once storage answers. Reads are
 * left out: a failed pull or recovery probe is not something waiting to sync.
 */
function awaitingRetry(entries: SyncLogEntry[], since: number | null): SyncLogEntry[] {
  const seen = new Set<string>();
  const out: SyncLogEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (since !== null && e.at < since) break;
    if (e.event !== 'fail' || !e.method || e.method === 'GET' || !e.path) continue;
    const key = `${e.method} ${e.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
