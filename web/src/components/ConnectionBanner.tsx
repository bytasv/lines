import { Box, Text } from '@mantine/core';
import { useStore } from '../store';

/** Floating pill centered in the header while the bridge link is down. `headerHeight` centers it vertically. */
export function ConnectionBanner({ headerHeight }: { headerHeight: number }) {
  const status = useStore((s) => s.connectionStatus);
  const queued = useStore((s) => s.queuedPrompts.length);
  // Relay up, machine gone. Before bootstrap the ConnectingMachine screen says this;
  // after it, nothing did — the app rendered a healthy "connected" UI in which every
  // action silently went nowhere.
  const machineOffline = useStore((s) => s.machineOffline);
  const bootstrapped = useStore((s) => s.bootstrapped);
  const machineGone = machineOffline && bootstrapped;
  if (status === 'connected' && !machineGone) return null;

  const base =
    status === 'connected'
      ? 'Your machine is offline — start Lines on it to reconnect.'
      : status === 'offline'
        ? "You're offline — waiting for network…"
        : 'Disconnected — reconnecting…';
  const label = queued > 0 ? `${base} · ${queued} message${queued === 1 ? '' : 's'} queued` : base;

  return (
    <Box
      style={{
        position: 'fixed',
        top: `calc(var(--lines-safe-top) + ${headerHeight / 2}px)`,
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 200,
        background: 'var(--mantine-color-red-filled)',
        color: 'var(--mantine-color-white)',
        borderRadius: 'var(--mantine-radius-xl)',
        padding: '4px 14px',
        boxShadow: 'var(--mantine-shadow-sm)',
        // Was `nowrap`, which at 390px pushed the pill off both edges of the
        // screen. Capped and allowed to wrap instead: the text is a sentence,
        // and two lines of it are readable where a clipped line is not.
        maxWidth: 'calc(100vw - 2rem)',
        textAlign: 'center',
      }}
    >
      <Text size="sm" fw={500}>
        {label}
      </Text>
    </Box>
  );
}
