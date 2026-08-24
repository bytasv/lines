import { useEffect, useState } from 'react';
import { Button, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { IconDeviceLaptop, IconPlus, IconRefresh, IconUnlink } from '@tabler/icons-react';
import type { Device } from '../lib/storage';
import { unlinkedMachineHealth } from '../lib/machineHealth';
import { useStore } from '../store';
import { MachineDot } from './MachineDot';
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
 *
 * The actions escalate deliberately: re-dial, use another machine, pair a new
 * one, and only then unpair. Unpair is last and destructive, but it is the one
 * that cannot dead-end — the machine answers a revoke by showing a fresh pairing
 * code, so "pair another machine" stops asking for a code nothing will issue.
 */
export function ConnectingMachine({
  name,
  others,
  onSwitch,
  onPairNew,
  onReconnect,
  onUnpair,
}: {
  name: string;
  /** Every other machine on the account, so a dead one is never a dead end. */
  others: Device[];
  onSwitch: (id: string) => void;
  onPairNew: () => void;
  onReconnect: () => void | Promise<void>;
  onUnpair: () => void | Promise<void>;
}) {
  const status = useStore((s) => s.connectionStatus);
  // The relay told us no bridge is attached. A fact, where `slow` is a guess.
  const offline = useStore((s) => s.machineOffline);
  const [slow, setSlow] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Unpair is destructive, so the second click is the one that does it. */
  const [confirmUnpair, setConfirmUnpair] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, []);

  const reconnect = async () => {
    setBusy(true);
    try {
      await onReconnect();
    } finally {
      setBusy(false);
    }
  };

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
            {offline
              ? 'That machine is not connected right now.'
              : status === 'connected'
                ? 'Loading your sessions and projects…'
                : 'Waiting for your machine to answer…'}
          </GateHint>
        </Stack>

        {(offline || slow) && (
          <Stack align="center" gap="xs" mt="xs" maw={420}>
            <GateHint>
              {offline
                ? `Lines is not running on ${name}, or the machine is asleep. Wake it and open Lines, then reconnect.`
                : `Taking longer than usual. Check that Lines is running on ${name} and that the machine is awake.`}
            </GateHint>

            <Button
              variant="light"
              size="xs"
              leftSection={<IconRefresh size={14} />}
              loading={busy}
              onClick={() => void reconnect()}
              mt={4}
            >
              Reconnect now
            </Button>

            {others.length > 0 && (
              <Stack align="stretch" gap={6} w="100%" mt={4}>
                <Text size="xs" c="dimmed" ta="center">
                  Or use a different machine:
                </Text>
                {others.map((device) => {
                  // No socket to these, so the only honest signal is the relay's
                  // presence report — and "seen 2h ago" once that goes stale.
                  // Switching to a machine that is also asleep is the dead end
                  // this screen exists to avoid.
                  const health = unlinkedMachineHealth(device);
                  return (
                    <Button
                      key={device.id}
                      variant="light"
                      size="xs"
                      leftSection={<IconDeviceLaptop size={14} />}
                      rightSection={
                        <Group gap={5} wrap="nowrap">
                          <Text size="xs" c="dimmed">
                            {health.label}
                          </Text>
                          <MachineDot health={health} />
                        </Group>
                      }
                      justify="space-between"
                      onClick={() => onSwitch(device.id)}
                    >
                      {device.name}
                    </Button>
                  );
                })}
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

            <Stack align="center" gap={2} mt={4}>
              <Button
                variant="subtle"
                size="xs"
                color="red"
                leftSection={<IconUnlink size={14} />}
                onClick={() => {
                  if (!confirmUnpair) {
                    setConfirmUnpair(true);
                    return;
                  }
                  void onUnpair();
                }}
              >
                {confirmUnpair ? 'Unpair — you’ll need a new code' : `Unpair ${name}`}
              </Button>
              <Text size="xs" c="dimmed" ta="center">
                {/* Says what happens next, because otherwise this looks like a
                    one-way door: the previous escape hatch asked for a pairing
                    code the machine would not issue while still claimed. */}
                Unpairing frees the machine. The Lines icon in its menu bar will show a fresh
                pairing code you can enter here.
              </Text>
            </Stack>
          </Stack>
        )}
      </Stack>
    </GateShell>
  );
}
