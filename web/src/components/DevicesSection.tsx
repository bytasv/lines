import { useCallback, useEffect, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconAlertCircle, IconDeviceLaptop, IconPlus, IconTrash } from '@tabler/icons-react';
import { useStore } from '../store';
import {
  claimDevice,
  forgetDeviceId,
  listDevices,
  rememberDeviceId,
  rememberedDeviceId,
  revokeDevice,
  type Device,
} from '../lib/storage';
import { switchDevice } from '../ws';

/**
 * The machines this account can run agent turns on.
 *
 * Lines runs the agent on the user's own computer, so this list is the set of
 * computers the hosted app can reach. Exactly one is active at a time — sessions
 * belong to a machine's filesystem, so there is no meaningful "all of them".
 */
export function DevicesSection() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [code, setCode] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const connected = useStore((s) => s.connectionStatus === 'connected');
  const activeId = rememberedDeviceId();

  const load = useCallback(() => {
    setError(null);
    listDevices()
      .then(setDevices)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(load, [load]);

  const pair = async () => {
    if (!code.trim()) return;
    setBusyId('pairing');
    setError(null);
    try {
      const device = await claimDevice(code);
      setCode('');
      setPairing(false);
      load();
      // Nothing is connected to the new machine yet, so make it the active one
      // only when there was nothing before — silently moving a working session
      // to a different computer would be worse than an extra click.
      if (!activeId) switchToDevice(device.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const switchToDevice = (id: string) => {
    rememberDeviceId(id);
    switchDevice(id);
  };

  const revoke = async (device: Device) => {
    setBusyId(device.id);
    setError(null);
    try {
      await revokeDevice(device.id);
      // Dropping the active machine leaves the app with nothing to talk to. Clear
      // the choice so a reload lands on the pairing screen rather than retrying a
      // device the relay will now refuse.
      if (device.id === activeId) forgetDeviceId();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Lines runs the agent on your own computer. These are the machines paired with this
        account; one is active at a time, and sessions belong to that machine’s files.
      </Text>

      {error && (
        <Alert color="red" icon={<IconAlertCircle size={16} />} variant="light">
          {error}
        </Alert>
      )}

      {!devices ? (
        <Group justify="center" p="md">
          <Loader size="sm" />
        </Group>
      ) : devices.length === 0 ? (
        <Text size="sm" c="dimmed">
          No machines paired yet.
        </Text>
      ) : (
        devices.map((device) => {
          const active = device.id === activeId;
          return (
            <Card key={device.id} withBorder padding="sm" radius="sm">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                  <IconDeviceLaptop size={20} opacity={0.6} />
                  <Stack gap={2} style={{ minWidth: 0 }}>
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm" fw={500} truncate>
                        {device.name}
                      </Text>
                      {active && (
                        // Active means "this browser points here". Connected means
                        // the socket is actually open — with the machine asleep the
                        // first is true and the second is not, and conflating them
                        // is what makes a dead link look healthy.
                        <Badge size="xs" color={connected ? 'green' : 'gray'} variant="light">
                          {connected ? 'connected' : 'active, not reachable'}
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {device.platform ?? 'unknown platform'} · {lastSeenLabel(device.lastSeenAt)}
                    </Text>
                  </Stack>
                </Group>
                <Group gap={4} wrap="nowrap">
                  {!active && (
                    <Button size="xs" variant="subtle" onClick={() => switchToDevice(device.id)}>
                      Use this
                    </Button>
                  )}
                  <Tooltip label="Revoke access" withArrow>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      loading={busyId === device.id}
                      onClick={() => void revoke(device)}
                      aria-label={`Revoke ${device.name}`}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Group>
            </Card>
          );
        })
      )}

      {pairing ? (
        <Card withBorder padding="sm" radius="sm">
          <Stack gap="xs">
            <Text size="sm">
              Run the Lines desktop app on the machine you want to add. It prints a pairing
              code on first launch.
            </Text>
            <Group gap="xs" wrap="nowrap">
              <TextInput
                placeholder="XXXXXXXX"
                value={code}
                onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && void pair()}
                style={{ flex: 1 }}
                autoFocus
              />
              <Button onClick={() => void pair()} loading={busyId === 'pairing'} disabled={!code.trim()}>
                Pair
              </Button>
              <Button variant="subtle" color="gray" onClick={() => { setPairing(false); setCode(''); }}>
                Cancel
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              Codes expire 15 minutes after the app prints one.
            </Text>
          </Stack>
        </Card>
      ) : (
        <Button
          variant="light"
          leftSection={<IconPlus size={16} />}
          onClick={() => setPairing(true)}
          style={{ alignSelf: 'flex-start' }}
        >
          Pair a machine
        </Button>
      )}

      <Text size="xs" c="dimmed">
        Revoking stops a machine reconnecting. It does not cut a connection that is
        already open — that ends when the machine next reconnects, or when you quit Lines
        there.
      </Text>
    </Stack>
  );
}

/** Relative, because the exact timestamp of a heartbeat is never what you want to know. */
function lastSeenLabel(iso: string | null): string {
  if (!iso) return 'never connected';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 120_000) return 'seen just now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `seen ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `seen ${hours}h ago`;
  return `seen ${Math.round(hours / 24)}d ago`;
}
