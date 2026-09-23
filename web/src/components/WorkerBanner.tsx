import { Box, Text } from '@mantine/core';
import { useStore } from '../store';

/**
 * Orange pill shown when the bridge can't reach the agent worker — the process
 * that owns the Claude CLI children. Without it a dead worker reads as an
 * unexplained Continue banner (or, on a cold-start protocol mismatch, as a
 * permanent spinner).
 *
 * More severe than StorageBanner's amber (agent turns are dead, not just cloud
 * sync), less than ConnectionBanner's red (the browser still has a bridge).
 * All of them render at the same fixed coordinates, so exactly one may show:
 * bridge-down wins over this, then contract skew (SkewBanner — this status was
 * read off messages the client may be misreading), and this wins over storage
 * (see StorageBanner).
 */
export function WorkerBanner({ headerHeight }: { headerHeight: number }) {
  const status = useStore((s) => s.workerStatus);
  const connection = useStore((s) => s.connectionStatus);
  const skew = useStore((s) => s.protocolSkew);
  if (connection !== 'connected' || status?.connected !== false) return null;
  if (skew) return null;

  // A version pair alone doesn't say which process is stale, so name both and
  // give the remedy for the common case (worker restarted onto a new protocol
  // while the bridge stayed put).
  const message = status.mismatch
    ? `Agent worker speaks v${status.mismatch.worker}, bridge speaks v${status.mismatch.bridge} — restart the bridge.`
    : `Agent worker not responding${
        status.since
          ? ` since ${new Date(status.since).toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
            })}`
          : ''
      }`;

  return (
    <Box
      style={{
        position: 'fixed',
        top: `calc(var(--lines-safe-top) + ${headerHeight / 2}px)`,
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 200,
        background: 'var(--mantine-color-orange-filled)',
        color: 'var(--mantine-color-black)',
        borderRadius: 'var(--mantine-radius-xl)',
        padding: '4px 14px',
        boxShadow: 'var(--mantine-shadow-sm)',
        whiteSpace: 'nowrap',
      }}
    >
      <Text size="sm" fw={500}>
        {message}
      </Text>
    </Box>
  );
}
