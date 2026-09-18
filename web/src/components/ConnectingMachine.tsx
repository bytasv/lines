import { useEffect, useState } from 'react';
import { Alert, Button, Card, Group, Loader, Stack, Text, TextInput, Title } from '@mantine/core';
import {
  IconDeviceLaptop,
  IconLock,
  IconPlus,
  IconRefresh,
  IconUnlink,
} from '@tabler/icons-react';
import { ENROLL_CODE_LENGTH, normalizeEnrollCode } from '@lines/shared';
import type { Device } from '../lib/storage';
import { cryptoUnavailable } from '../lib/e2ee';
import { enrollWithCode } from '../ws';
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
  deviceId,
  others,
  onSwitch,
  onPairNew,
  onReconnect,
  onUnpair,
}: {
  name: string;
  /** Which machine this is, so an enrollment can name it. */
  deviceId: string;
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
  // The machine answered, and refused this browser. Distinct from every other
  // state on this screen: nothing is asleep, nothing is slow, and waiting will
  // never resolve it — only enrolling a key will.
  const refusal = useStore((s) => s.e2eeRefusal);
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

  if (refusal) return <EnrollGate name={name} reason={refusal} deviceId={deviceId} />;

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

/**
 * The way back in when a machine refuses this browser for want of a key.
 *
 * This screen has to exist, and it has to be *here*: once a machine has an
 * enrolled browser it refuses every channel that cannot present a pinned key, so
 * a second computer never loads the app — and Settings → Encryption, the only
 * other place to enrol, lives behind the app. Without this, adding a second
 * machine after turning encryption on is impossible without a terminal.
 *
 * The socket behind this is deliberately silent (see `needsEnrollment` in
 * ws.ts): the enrollment frame is the only thing it may carry.
 */
function EnrollGate({ name, reason, deviceId }: { name: string; reason: string; deviceId: string }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read once per render rather than on submit: if this browser cannot do
  // cryptography at all, the form is a trap — better to say so before the code
  // is typed, since the fix is a different URL.
  const blocked = cryptoUnavailable();
  const ready = !blocked && normalizeEnrollCode(code).length === ENROLL_CODE_LENGTH;

  const enroll = async () => {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const result = await enrollWithCode(deviceId, code);
      // Success needs no branch: the pin is stored, the link reconnects
      // encrypted, and its `hello` clears the refusal — which unmounts this.
      if (result.error) setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // In `finally`, because a spinner that never stops is indistinguishable
      // from a request that never finishes.
      setBusy(false);
    }
  };

  return (
    <GateShell>
      <Stack align="center" gap="md" maw={460} w="100%">
        <IconLock size={36} stroke={1.4} />
        <Stack align="center" gap={4}>
          <Title order={4}>{name} needs this browser enrolled</Title>
          <GateHint>
            That machine is set up to accept only browsers it has a key for, so it refused this
            one. Enrol it once and this computer works like any other.
          </GateHint>
        </Stack>

        <Card withBorder radius="md" p="md" w="100%">
          <Stack gap="xs">
            {blocked && (
              <Alert color="orange" variant="light">
                {blocked}
              </Alert>
            )}
            <Text size="xs" c="dimmed">
              On {name}: open the Lines menu-bar icon and choose “Show encryption code” — or run{' '}
              <Text span ff="monospace" size="xs">
                npm run enroll -w server
              </Text>
              . Type what it shows here. The code itself never travels, and it works once.
            </Text>
            <TextInput
              placeholder="XXXXX XXXXX XXXXX XXXXX"
              value={code}
              onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && void enroll()}
              disabled={busy || !!blocked}
              autoFocus
            />
            {error && (
              <Alert color="red" variant="light">
                {error}
              </Alert>
            )}
            <Button onClick={() => void enroll()} disabled={!ready || busy} loading={busy}>
              Enrol this browser
            </Button>
          </Stack>
        </Card>

        <Text size="xs" c="dimmed" ta="center">
          {reason}
        </Text>
      </Stack>
    </GateShell>
  );
}
