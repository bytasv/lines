import { useEffect, useState } from 'react';
import { Alert, Badge, Box, Button, Group, Loader, Text } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconAlertCircle, IconCopy } from '@tabler/icons-react';
import type { SyncLogEntry } from '@lines/shared';
import { useStore } from '../store';
import { fileRequest } from '../ws';
import { SettingsGroup, SettingsRow } from './SettingsLayout';

/**
 * Why cloud sync dropped. The bridge writes a row only for a failed storage
 * request or an availability flip, so a healthy install shows an empty list —
 * and a user seeing the amber pill has something concrete to copy into a report
 * (the bridge console isn't reachable on a desktop or VPS install).
 */
export function SyncSection() {
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
    <>
      <SettingsGroup>
        <SettingsRow
          label="Status"
          description={status?.available === false ? status.reason : undefined}
          control={
            <Badge color={status?.available === false ? 'yellow' : 'green'} variant="light">
              {status?.available === false ? `unavailable${status.kind ? ` · ${status.kind}` : ''}` : 'connected'}
            </Badge>
          }
        />
      </SettingsGroup>

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
          footer="Newest first. These are the failures behind the “cloud sync unavailable” notice."
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
