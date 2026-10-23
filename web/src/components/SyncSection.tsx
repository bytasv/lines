import { useEffect, useState } from 'react';
import { Alert, Badge, Box, Button, Code, Group, Loader, Stack, Text } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconAlertCircle, IconCopy } from '@tabler/icons-react';
import type { SyncLogEntry, SyncPending, SyncSigningInfo } from '@lines/shared';
import { formatTimestamp } from '@lines/shared';
import { syncIndicator, useStore } from '../store';
import type { SyncIndicator } from '../store';
import { fileRequest, send } from '../ws';
import { SettingsGroup, SettingsRow } from './SettingsLayout';

/**
 * Why cloud sync dropped, and what is waiting for it. The bridge writes a log
 * row only for a failed storage request or an availability flip, so a healthy
 * install shows an empty list — and a user wondering about the header's sync
 * dot has something concrete to copy into a report (the bridge console isn't
 * reachable on a desktop or VPS install).
 */
export function SyncSection() {
  // The live status, not the one the route returns beside the rows: it is
  // broadcast on every flip, so this pane can't go stale while it is open.
  const status = useStore((s) => s.storageStatus);
  const signing = useStore((s) => s.syncSigning);
  const { entries, error } = useSyncLog(true);
  const clipboard = useClipboard({ timeout: 1500 });
  const sync = status ? syncIndicator(status) : null;

  // Newest first: an outage is read from its most recent row backwards.
  const rows = entries ? [...entries].reverse() : [];

  return (
    <>
      <SettingsGroup>
        <SettingsRow
          label="Status"
          description={
            sync
              ? [cloudLabel(sync), sync.cloud === 'unreachable' ? status?.reason : undefined]
                  .filter(Boolean)
                  .join(' — ')
              : undefined
          }
          control={
            <Badge color={sync?.cloud === 'ok' || !sync ? 'green' : 'gray'} variant="light">
              {sync ? SYNC_STATE_LABEL[sync.state] : 'connected'}
            </Badge>
          }
        />
        {sync?.pending && (
          <SettingsRow label="Waiting to sync">
            <Box mt={6}>
              <SyncPendingList pending={sync.pending} />
            </Box>
          </SettingsRow>
        )}
      </SettingsGroup>

      <SigningGroup info={signing} />

      {error && (
        <Alert color="red" icon={<IconAlertCircle size={16} />} variant="light">
          {error}
        </Alert>
      )}

      {rows.length > 0 && (
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
      )}

      {!entries && !error ? (
        <Group justify="center" p="md">
          <Loader size="sm" />
        </Group>
      ) : (
        <SettingsGroup
          title="Failures"
          footer="Newest first. These are the failures behind a paused cloud sync."
        >
          {rows.length === 0 ? (
            <Box px="md" py="sm">
              <Text size="sm" c="dimmed">
                No sync failures recorded.
              </Text>
            </Box>
          ) : (
            rows.map((entry, i) => (
              <Group key={`${entry.at}-${i}`} gap="xs" wrap="nowrap" align="baseline" px="md" py={6}>
                <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                  {new Date(entry.at).toLocaleString()}
                </Text>
                <Badge size="xs" variant="light" color={EVENT_COLOR[entry.event]} style={{ flexShrink: 0 }}>
                  {entry.event}
                </Badge>
                <Text size="xs" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  {syncLogDetail(entry)}
                </Text>
              </Group>
            ))
          )}
        </SettingsGroup>
      )}
    </>
  );
}

/**
 * Which machines may write what runs here. Every workflow, step and recipe a
 * machine syncs carries its signature; another machine's is held back until
 * the user reviews it, or trusts that machine — and the only thing that makes a
 * key safe to trust is that its fingerprint matches the one shown here on a
 * machine of theirs. Hence this machine's own fingerprint, for the user to
 * carry the other way, and the list of trusted ones, each revocable.
 */
function SigningGroup({ info }: { info: SyncSigningInfo | null }) {
  // An older bridge, or a guest's view: nothing to show, and nothing to revoke.
  if (!info) return null;
  return (
    <SettingsGroup
      title="Signing"
      footer="Trust another machine only after checking that the fingerprint it asks you to trust is the one shown here, on that machine. A fingerprint you have not seen on a machine of your own could belong to anyone."
    >
      <SettingsRow
        label="This machine’s fingerprint"
        description="What this machine syncs is signed with this key. Compare it when another of your machines asks you to trust this one."
        control={
          info.fingerprint ? (
            <Code>{info.fingerprint}</Code>
          ) : (
            <Text size="xs" c="dimmed">
              Created on the first sync
            </Text>
          )
        }
      />
      {info.trusted.length === 0 ? (
        <SettingsRow
          label="Trusted machines"
          description="None. What another machine signs is held back here until you review it, or trust that machine."
        />
      ) : (
        info.trusted.map((machine) => (
          <SettingsRow
            key={machine.key}
            label={<Code>{machine.fingerprint}</Code>}
            description={`Trusted ${formatTimestamp(machine.trustedAt)}. What it signs runs here without a review.`}
            control={
              <Button
                size="xs"
                variant="subtle"
                color="red"
                // Revoking only ever holds things back again, so it needs no confirmation.
                onClick={() => send({ type: 'untrustSigner', key: machine.key })}
              >
                Remove
              </Button>
            }
          />
        ))
      )}
    </SettingsGroup>
  );
}

const EVENT_COLOR: Record<SyncLogEntry['event'], string> = {
  fail: 'gray',
  down: 'yellow',
  up: 'green',
};

/**
 * `sync-log.jsonl`, read through the primary machine's bridge — the one whose
 * `storageStatus` every caller shows beside it. Fetched each time `enabled`
 * turns on, so a popover reopened later reads fresh rows.
 */
export function useSyncLog(enabled: boolean): { entries: SyncLogEntry[] | null; error: string | null } {
  const primary = useStore((s) => s.primaryDeviceId);
  const [entries, setEntries] = useState<SyncLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setError(null);
    // `?? ''`: a direct local bridge's link is keyed by the empty id.
    fileRequest('syncLog', {}, primary ?? '')
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
  }, [enabled, primary]);

  return { entries, error };
}

export const SYNC_STATE_LABEL: Record<SyncIndicator['state'], string> = {
  synced: 'synced',
  syncing: 'syncing',
  pending: 'waiting',
  paused: 'paused',
};

/** The cloud half of the status, in words: which state, and since when. */
export function cloudLabel(sync: SyncIndicator): string {
  const since = sync.since ? ` since ${formatTimestamp(sync.since)}` : '';
  if (sync.cloud === 'signedOut') return `Not signed in to Lines Cloud${since}`;
  if (sync.cloud === 'unreachable') return `Lines Cloud out of reach${since}`;
  return 'Connected to Lines Cloud';
}

const PENDING_LABELS: [keyof SyncPending, string][] = [
  ['sessions', 'Sessions'],
  ['deletes', 'Deletions'],
  ['workflows', 'Workflows'],
  ['steps', 'Steps'],
  ['recipes', 'Recipes'],
  ['settings', 'Settings'],
  ['memory', 'Memory'],
];

/** Local writes storage has not confirmed yet, one line per kind that has any. */
export function SyncPendingList({ pending }: { pending: SyncPending }) {
  const rows = PENDING_LABELS.filter(([key]) => pending[key] > 0);
  if (rows.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        Nothing waiting — everything here is in the cloud.
      </Text>
    );
  }
  return (
    <Stack gap={2}>
      {rows.map(([key, label]) => (
        <Group key={key} justify="space-between" gap="xs" wrap="nowrap">
          <Text size="xs">{label}</Text>
          <Text size="xs" fw={600}>
            {pending[key]}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}

/** One row as a line: what was tried, what came back, how long it took. */
export function syncLogDetail(entry: SyncLogEntry): string {
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
