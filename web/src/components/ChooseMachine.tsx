import { Badge, Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { IconDeviceLaptop, IconPlus } from '@tabler/icons-react';
import type { Device } from '../lib/storage';
import { lastSeenLabel, unlinkedMachineHealth } from '../lib/machineHealth';
import { GateHint, GateShell } from './GateShell';
import { MachineDot } from './MachineDot';

/**
 * Pick which machine this browser is going to drive — explicitly, the first
 * time, even when there is only one.
 *
 * The gate used to choose for you: remembered, else the most recently seen of
 * your own. That is right for the *second* visit and wrong for the first. A
 * browser that silently attaches to a computer never told the user which
 * computer, which is the one fact this whole product is about — the agent runs
 * on a specific machine, edits that machine's files, and runs commands there. It
 * also made the enrollment screen that follows read as an interruption rather
 * than as the next step of connecting to the thing you just picked.
 *
 * So the heuristic is kept for later visits and skipped for the first one. One
 * machine still gets a list of one: seeing your machine named, with its health,
 * and choosing it is a second of work that makes everything after it legible.
 */
export function ChooseMachine({
  devices,
  onPick,
  onPairNew,
}: {
  devices: Device[];
  onPick: (id: string) => void;
  onPairNew: () => void;
}) {
  return (
    <GateShell>
      <Stack gap="lg" maw={520} w="100%">
        <Stack gap={4}>
          <Title order={3}>Choose a machine</Title>
          <GateHint>
            Lines runs the agent on one of your own computers — it reads and edits that machine's
            files. Pick the one you want to work on.
          </GateHint>
        </Stack>

        <Stack gap="xs">
          {devices.map((device) => {
            // No socket to any of these yet, so the only honest signal is the
            // relay's presence report, decaying to "last seen" once stale.
            const health = unlinkedMachineHealth(device);
            return (
              <Card key={device.id} withBorder padding="sm" radius="sm">
                <Group justify="space-between" wrap="nowrap">
                  <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                    <IconDeviceLaptop size={20} opacity={0.6} />
                    <Stack gap={2} style={{ minWidth: 0 }}>
                      <Group gap={6} wrap="nowrap">
                        <MachineDot health={health} />
                        <Text size="sm" fw={500} truncate>
                          {device.name}
                        </Text>
                        {device.shared && (
                          // Somebody else's computer: everything you run there
                          // happens on their machine, as them.
                          <Badge size="xs" color="grape" variant="light">
                            {device.ownerProfile?.name ?? device.ownerProfile?.email ?? 'shared with you'}
                          </Badge>
                        )}
                      </Group>
                      <Text size="xs" c="dimmed">
                        {device.platform ?? 'unknown platform'} · {health.label}
                        {health.state !== 'online' ? ` · ${lastSeenLabel(device.lastSeenAt)}` : ''}
                      </Text>
                    </Stack>
                  </Group>
                  <Button size="xs" onClick={() => onPick(device.id)}>
                    Use this
                  </Button>
                </Group>
              </Card>
            );
          })}
        </Stack>

        <Button
          variant="subtle"
          size="xs"
          leftSection={<IconPlus size={14} />}
          onClick={onPairNew}
        >
          Pair a new machine
        </Button>

        <GateHint>
          You can switch machines at any time from Settings → Machines, and hold more than one at
          once — a session always runs on the machine it was started on.
        </GateHint>
      </Stack>
    </GateShell>
  );
}
