import { useState } from 'react';
import { Box, Text, UnstyledButton } from '@mantine/core';
import type { StorageStatus } from '@lines/shared';
import { useStore } from '../store';
import { SettingsModal } from './SettingsModal';

/**
 * Amber pill shown when the bridge can't reach the storage server / Supabase.
 * Distinct from the red ConnectionBanner: the bridge link is fine and local
 * persistence still works — only cross-machine cloud sync is paused. Hidden
 * while the browser<->bridge link itself is down (that red banner wins), or
 * while the agent worker is down (WorkerBanner wins — a dead agent outranks
 * paused sync, and all the pills share one fixed position), or while the client
 * and the bridge disagree on the wire contract (SkewBanner wins — this status
 * was read off messages the client may be misreading).
 *
 * Clicking opens Settings → Sync, where the failure rows behind the pill live:
 * the reason used to be a hover `title` and nothing else, which is why nobody
 * could say what this banner was actually reporting.
 */
export function StorageBanner({ headerHeight }: { headerHeight: number }) {
  const status = useStore((s) => s.storageStatus);
  const worker = useStore((s) => s.workerStatus);
  const connection = useStore((s) => s.connectionStatus);
  const skew = useStore((s) => s.protocolSkew);
  const [settingsOpen, setSettingsOpen] = useState(false);
  if (connection !== 'connected' || status?.available !== false) return null;
  if (worker?.connected === false || skew) return null;

  return (
    <>
      <UnstyledButton
        onClick={() => setSettingsOpen(true)}
        title={status.reason}
        style={{
          position: 'fixed',
          top: `calc(var(--lines-safe-top) + ${headerHeight / 2}px)`,
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 200,
        }}
      >
        <Box
          style={{
            background: 'var(--mantine-color-yellow-filled)',
            color: 'var(--mantine-color-black)',
            borderRadius: 'var(--mantine-radius-xl)',
            padding: '4px 14px',
            boxShadow: 'var(--mantine-shadow-sm)',
            whiteSpace: 'nowrap',
            maxWidth: '80vw',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          <Text size="sm" fw={500} truncate>
            {headline(status)}
            {detail(status) && <Text span size="xs" opacity={0.75}> — {detail(status)}</Text>}
          </Text>
        </Box>
      </UnstyledButton>
      <SettingsModal
        opened={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialSection="diagnostics"
      />
    </>
  );
}

/** An expired token is a different story from an unreachable server; say which. */
function headline(status: StorageStatus): string {
  if (status.kind === 'auth') return 'Cloud sync paused — reauthenticating.';
  return 'Cloud sync unavailable — changes saved on this machine only.';
}

/** How long it has been down, plus the shortest useful piece of the cause. */
function detail(status: StorageStatus): string {
  const parts: string[] = [];
  if (status.since) parts.push(sinceLabel(status.since));
  if (status.reason) parts.push(status.reason.slice(0, 80));
  return parts.join(' · ');
}

function sinceLabel(since: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}
