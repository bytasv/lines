import { Box, Text } from '@mantine/core';
import { useStore } from '../store';

/**
 * Amber pill shown when the bridge can't reach the storage server / Supabase.
 * Distinct from the red ConnectionBanner: the bridge link is fine and local
 * persistence still works — only cross-machine cloud sync is paused. Hidden
 * while the browser<->bridge link itself is down (that red banner wins).
 */
export function StorageBanner({ headerHeight }: { headerHeight: number }) {
  const status = useStore((s) => s.storageStatus);
  const connection = useStore((s) => s.connectionStatus);
  if (connection !== 'connected' || status?.available !== false) return null;

  return (
    <Box
      style={{
        position: 'fixed',
        top: headerHeight / 2,
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 200,
        background: 'var(--mantine-color-yellow-filled)',
        color: 'var(--mantine-color-black)',
        borderRadius: 'var(--mantine-radius-xl)',
        padding: '4px 14px',
        boxShadow: 'var(--mantine-shadow-sm)',
        whiteSpace: 'nowrap',
      }}
      title={status?.reason}
    >
      <Text size="sm" fw={500}>
        Cloud sync unavailable — changes saved on this machine only.
      </Text>
    </Box>
  );
}
