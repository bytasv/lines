import { useEffect, useState } from 'react';
import { Badge, Group, Indicator, Menu, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconDeviceLaptop, IconSettings } from '@tabler/icons-react';
import { useStore } from '../store';
import { useDevices } from '../lib/devices';
import { machineActivity } from '../lib/format';
import { sessionsOnMachine } from '../lib/machines';
import {
  linkedMachineHealth,
  unlinkedMachineHealth,
  type MachineHealth,
} from '../lib/machineHealth';
import { rememberDeviceId, rememberedDeviceId, type Device } from '../lib/storage';
import { SHARING_ENABLED } from '../lib/shares';
import { switchDevice } from '../ws';
import { MachineDot } from './MachineDot';
import { SettingsModal } from './SettingsModal';

/**
 * Which machine the session list describes, and the way to change it.
 *
 * The client holds a link to every machine it can reach — that is how a session
 * left running on a shared machine still raises a notification — but only one
 * machine's sessions are listed at a time, because the project tabs, the library
 * and the account around them all belong to exactly one computer. Before this
 * the header said nothing about which one that was, and switching meant going
 * through Settings → Machines.
 *
 * Hosted deployments only: with no storage server there is one machine and no
 * grants, which is why the Machines pane is hidden there too.
 */
export function MachineSwitcher() {
  const devices = useDevices((s) => s.devices);
  const load = useDevices((s) => s.refresh);
  const machines = useStore((s) => s.machines);
  const sessions = useStore((s) => s.sessions);
  const sessionMachine = useStore((s) => s.sessionMachine);
  // The machine the UI is pointed at, from the store rather than storage, so the
  // control re-renders on a switch. The remembered id covers the moment before
  // the first link is up and has named one.
  const primaryDeviceId = useStore((s) => s.primaryDeviceId);
  const activeId = primaryDeviceId ?? rememberedDeviceId();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (SHARING_ENABLED) void load();
  }, [load]);

  /**
   * Health per row, from that machine's own slice when a link is held and from
   * the relay's presence report when not — the rule `useSessionMachineHealth`
   * follows. Reading the banner scalars instead would answer for the primary
   * machine on every row, which is the one question this menu exists to ask.
   */
  const healthOf = (device: Device): MachineHealth => {
    const slice = machines[device.id];
    return slice?.connectionStatus === 'connected'
      ? linkedMachineHealth({
          bridgeAttached: !slice.machineOffline,
          worker: slice.worker,
          storage: slice.storage,
        })
      : unlinkedMachineHealth(device);
  };

  /**
   * What is happening on a machine, counted from the sessions the client already
   * holds for it.
   *
   * Null unless there is a live link: without one the client holds none of that
   * machine's sessions, and a zero would read as "nothing running there" rather
   * than "not connected". Null for a shared machine as well — a guest holds only
   * what was shared with them, so a count would describe their slice while
   * reading as the machine's total.
   */
  const activityOf = (device: Device): { running: number; actionable: number } | null => {
    const slice = machines[device.id];
    if (!slice?.bootstrapped || slice.view.access) return null;
    return machineActivity(Object.values(sessionsOnMachine(sessions, sessionMachine, device.id)));
  };

  if (!SHARING_ENABLED) return null;

  // What the closed control has to say: a machine that is not on screen needs
  // the user. Background links keep alerting, so without this a chime names a
  // session the sidebar does not list.
  let elsewhere = 0;
  for (const device of devices ?? []) {
    if (device.id === activeId) continue;
    elsewhere += activityOf(device)?.actionable ?? 0;
  }

  const active = devices?.find((d) => d.id === activeId) ?? null;
  const pick = (id: string) => {
    // `switchDevice` keeps the machine being left linked and arms its idle timer,
    // so this is a change of view, not a disconnection.
    if (id !== activeId) {
      rememberDeviceId(id);
      switchDevice(id);
    }
  };

  const menu = (
    <Menu position="bottom-start" width="min(320px, calc(100vw - 2rem))" withinPortal>
      <Menu.Target>
        {/* Icon-only, and deliberately: the header's width belongs to the
            project tabs, and MachineDot already carries the machine's health in
            its own tooltip. */}
        <UnstyledButton
          aria-label="Switch machine"
          px={4}
          py={2}
          style={{ borderRadius: 6, display: 'flex', alignItems: 'center', gap: 2 }}
        >
          {active ? (
            <MachineDot health={healthOf(active)} />
          ) : (
            <IconDeviceLaptop size={13} opacity={0.6} />
          )}
          <IconChevronDown size={12} opacity={0.6} />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Machine</Menu.Label>
        {(devices ?? []).map((device) => {
          const health = healthOf(device);
          const activity = device.id === activeId ? null : activityOf(device);
          return (
            <Menu.Item
              key={device.id}
              onClick={() => pick(device.id)}
              leftSection={<MachineDot health={health} />}
            >
              <Group gap={6} wrap="nowrap">
                <Text size="xs" fw={device.id === activeId ? 600 : 400} truncate>
                  {device.name}
                </Text>
                {device.shared && (
                  // Somebody else's computer. Named, because everything you run
                  // there happens on their machine, as them.
                  <Badge size="xs" color="grape" variant="light">
                    {device.ownerProfile?.name ?? device.ownerProfile?.email ?? 'shared with you'}
                  </Badge>
                )}
              </Group>
              <Text size="xs" c="dimmed" truncate>
                {health.label}
                {activity && activity.running > 0 ? ` · ${activity.running} running` : ''}
                {activity && activity.actionable > 0 ? ` · ${activity.actionable} needs you` : ''}
              </Text>
            </Menu.Item>
          );
        })}
        {devices?.length === 0 && (
          <Menu.Item disabled>
            <Text size="xs">No machines paired yet</Text>
          </Menu.Item>
        )}
        <Menu.Divider />
        <Menu.Item leftSection={<IconSettings size={14} />} onClick={() => setSettingsOpen(true)}>
          Manage machines…
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );

  return (
    <>
      {/* The dot rides the whole control, as the gear's does in HeaderActions:
          an Indicator inside Menu.Target would sit between the menu and the
          element it has to hand its ref to. */}
      <Indicator size={6} color="yellow" disabled={elsewhere === 0} offset={2}>
        {menu}
      </Indicator>
      {/* Mounted outside the dropdown: choosing the item closes the menu, which
          unmounts the dropdown and would take the modal with it. */}
      <SettingsModal
        opened={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialSection="devices"
      />
    </>
  );
}
