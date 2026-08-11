import { useEffect, useState } from 'react';
import { Button, Loader, Stack, Text, Title } from '@mantine/core';
import { IconDeviceLaptop, IconPlus } from '@tabler/icons-react';
import type { Device } from '../lib/storage';
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
 * escalates — and, crucially, offers a way out. Waiting is not a recoverable
 * state on its own: the socket reaches the relay and simply finds no agent
 * attached, so retrying forever changes nothing. Without the actions below the
 * only advice was "switch machines from Settings", which is unreachable because
 * Settings lives behind this very gate.
 */
export function ConnectingMachine({
  name,
  others,
  onSwitch,
  onPairNew,
}: {
  name: string;
  /** Every other machine on the account, so a dead one is never a dead end. */
  others: Device[];
  onSwitch: (id: string) => void;
  onPairNew: () => void;
}) {
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
          <Stack align="center" gap="xs" mt="xs" maw={420}>
            <GateHint>
              Taking longer than usual. Check that Lines is running on {name} and that the
              machine is awake.
            </GateHint>

            {others.length > 0 && (
              <Stack align="stretch" gap={6} w="100%" mt={4}>
                <Text size="xs" c="dimmed" ta="center">
                  Or use a different machine:
                </Text>
                {others.map((device) => (
                  <Button
                    key={device.id}
                    variant="light"
                    size="xs"
                    leftSection={<IconDeviceLaptop size={14} />}
                    onClick={() => onSwitch(device.id)}
                  >
                    {device.name}
                  </Button>
                ))}
              </Stack>
            )}

            <Button
              variant="subtle"
              size="xs"
              color="gray"
              leftSection={<IconPlus size={14} />}
              onClick={onPairNew}
            >
              Pair another machine
            </Button>
          </Stack>
        )}
      </Stack>
    </GateShell>
  );
}
