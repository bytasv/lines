import { useEffect, useState } from 'react';
import { Loader, Stack, Text, Title } from '@mantine/core';
import { useStore } from '../store';
import { GateHint, GateShell } from './GateShell';

/** After this long, a connection that has not landed is worth explaining rather than just spinning. */
const SLOW_MS = 6000;

/**
 * The gap between "we know which machine" and "that machine has told us its
 * state". Two things have to happen — the socket opens, then `hello` arrives —
 * and rendering the app before the second one shows a complete UI containing no
 * sessions and no projects, which reads as data loss rather than as loading.
 *
 * A machine that is asleep or not running Lines never finishes this, so the copy
 * escalates instead of spinning forever with no explanation.
 */
export function ConnectingMachine({ name }: { name: string }) {
  const status = useStore((s) => s.connectionStatus);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <GateShell>
      <Stack align="center" gap="md">
        <Loader size="lg" />
        <Stack align="center" gap={4}>
          <Title order={4}>
            {/* Named, because the whole point of the split is that the work
                happens on a specific computer of theirs. */}
            Connecting to {name}
          </Title>
          <GateHint>
            {status === 'connected'
              ? 'Loading your sessions and projects…'
              : 'Waiting for your machine to answer…'}
          </GateHint>
        </Stack>

        {slow && (
          <Stack align="center" gap={2} mt="xs">
            <GateHint>
              Taking longer than usual. Check that Lines is running on {name} and that the
              machine is awake.
            </GateHint>
            <Text size="xs" c="dimmed">
              You can switch machines from Settings once connected.
            </Text>
          </Stack>
        )}
      </Stack>
    </GateShell>
  );
}
