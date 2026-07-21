import { Box, Text } from '@mantine/core';
import { useStore } from '../store';

/** Floating pill centered in the header while the bridge link is down. `headerHeight` centers it vertically. */
export function ConnectionBanner({ headerHeight }: { headerHeight: number }) {
  const status = useStore((s) => s.connectionStatus);
  const queued = useStore((s) => s.queuedPrompts.length);
  if (status === 'connected') return null;

  const base = status === 'offline' ? "You're offline — waiting for network…" : 'Disconnected — reconnecting…';
  const label = queued > 0 ? `${base} · ${queued} message${queued === 1 ? '' : 's'} queued` : base;

  return (
    <Box
      style={{
        position: 'fixed',
        top: headerHeight / 2,
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 200,
        background: 'var(--mantine-color-red-filled)',
        color: 'var(--mantine-color-white)',
        borderRadius: 'var(--mantine-radius-xl)',
        padding: '4px 14px',
        boxShadow: 'var(--mantine-shadow-sm)',
        whiteSpace: 'nowrap',
      }}
    >
      <Text size="sm" fw={500}>
        {label}
      </Text>
    </Box>
  );
}
