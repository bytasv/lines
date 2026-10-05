import { Box, Text } from '@mantine/core';
import { useEffect, useReducer, useState } from 'react';
import { DISCONNECT_BANNER_GRACE_MS, showDisconnectBanner } from '../lib/wake';
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
  // When the link left `connected`. Keyed on up/down rather than on the status
  // itself, so a `reconnecting` <-> `offline` change inside one outage keeps the
  // original stamp; one timer re-renders once the grace has run out.
  const down = status !== 'connected';
  const [downSince, setDownSince] = useState<number | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!down) {
      setDownSince(null);
      return;
    }
    setDownSince(Date.now());
    const timer = setTimeout(rerender, DISCONNECT_BANNER_GRACE_MS);
    return () => clearTimeout(timer);
  }, [down]);

  // machineGone is relay truth about the remote machine, not a resume redial,
  // so it stays immediate.
  if (!machineGone && !showDisconnectBanner({ status, downSince, now: Date.now() })) return null;

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
