import { useEffect, useId, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconCheck,
  IconLogout,
  IconPencil,
  IconPlus,
  IconTrash,
  IconUserPlus,
  IconX,
} from '@tabler/icons-react';
import { useStore } from '../store';
import {
  claimDevice,
  forgetDeviceId,
  rememberDeviceId,
  rememberedDeviceId,
  renameDevice,
  revokeDevice,
  type Device,
} from '../lib/storage';
import { useDevices } from '../lib/devices';
import { machineActivity } from '../lib/format';
import { useIsGuest } from '../lib/can';
import {
  lastSeenLabel,
  linkedMachineHealth,
  unlinkedMachineHealth,
  type MachineHealth,
} from '../lib/machineHealth';
import { SHARING_ENABLED, leaveShare } from '../lib/shares';
import { disconnectMachine, switchDevice } from '../ws';
import { ConfirmModal } from './ConfirmModal';
import { DownloadDesktopApp } from './DownloadDesktopApp';
import { MachineDot } from './MachineDot';
import { SettingsGroup, SettingsRow } from './SettingsLayout';
import { ShareModal } from './ShareModal';

/**
 * The machines this account can run agent turns on.
 *
 * Lines runs the agent on the user's own computer, so this list is the set of
 * computers the hosted app can reach. Exactly one is active at a time — sessions
 * belong to a machine's filesystem, so there is no meaningful "all of them".
 */
export function DevicesSection() {
  // The same store the device gate reads: revoking the machine in use here has to
  // put that gate back up, which a fetch local to this pane could not do.
  const devices = useDevices((s) => s.devices);
  const storeError = useDevices((s) => s.error);
  const load = useDevices((s) => s.refresh);
  const [pairing, setPairing] = useState(false);
  const [code, setCode] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The machine being renamed, and the text so far. */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  /**
   * The machine whose share dialog is open. Settings is where people look for
   * "give someone else access", and until this existed the only way in was the
   * machine-scope link inside a *session's* share dialog — so a user with no
   * session open concluded the feature did not exist.
   */
  const [sharing, setSharing] = useState<Device | null>(null);
  /** The machine whose revoke is waiting on confirmation. */
  const [confirmRevoke, setConfirmRevoke] = useState<Device | null>(null);
  const codeId = useId();
  const connected = useStore((s) => s.connectionStatus === 'connected');
  // Health of the machine this browser is actually linked to comes off the socket,
  // not off the device row: the row is an HTTP snapshot, and only the link knows
  // whether the bridge is attached and whether its worker answers.
  const machineOffline = useStore((s) => s.machineOffline);
  const worker = useStore((s) => s.workerStatus);
  const storageStatus = useStore((s) => s.storageStatus);
  const activeId = rememberedDeviceId();
  const error = actionError ?? storeError;
  const activeHealth: MachineHealth | null = connected
    ? linkedMachineHealth({ bridgeAttached: !machineOffline, worker, storage: storageStatus })
    : null;
  // Only for the linked machine: the client holds no sessions for the others, and
  // an absent count must not read as "nothing running there".
  //
  // Suppressed entirely for a guest: they hold only the sessions they were
  // granted, so a count would describe their slice while reading as the host
  // machine's total.
  const sessions = useStore((s) => s.sessions);
  const guest = useIsGuest();
  const activity = guest
    ? { running: 0, actionable: 0 }
    : machineActivity(Object.values(sessions));

  useEffect(() => {
    void load();
  }, [load]);

  const pair = async () => {
    if (!code.trim()) return;
    setBusyId('pairing');
    setActionError(null);
    try {
      const device = await claimDevice(code);
      setCode('');
      setPairing(false);
      await load();
      // Nothing is connected to the new machine yet, so make it the active one
      // only when there was nothing before — silently moving a working session
      // to a different computer would be worse than an extra click.
      if (!activeId) switchToDevice(device.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const switchToDevice = (id: string) => {
    rememberDeviceId(id);
    switchDevice(id);
  };

  const rename = async () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name) return;
    setBusyId(renaming.id);
    setActionError(null);
    try {
      await renameDevice(renaming.id, name);
      setRenaming(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (device: Device) => {
    setBusyId(device.id);
    setActionError(null);
    try {
      await revokeDevice(device.id);
      // Dropping the active machine leaves the app with nothing to talk to. Clear
      // the choice first, then refresh: the gate reads both, and in that order it
      // falls through to the pairing screen instead of briefly re-selecting a
      // machine the relay will now refuse.
      if (device.id === activeId) forgetDeviceId();
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Give up a machine somebody shared with you.
   *
   * Mirrors `revoke` above, with one step it cannot skip: the link to a shared
   * machine is held open in the background, so it has to be closed here or it
   * keeps retrying against a grant that no longer exists. With the row gone and
   * the remembered id cleared, the device gate falls back to the chooser.
   */
  const leave = async (device: Device) => {
    setBusyId(device.id);
    setActionError(null);
    try {
      await leaveShare(device.id);
      disconnectMachine(device.id);
      if (device.id === activeId) forgetDeviceId();
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const renderDevice = (device: Device) => {
    const active = device.id === activeId;
    // Three states, kept apart: linked (the socket is the source of truth),
    // and not linked (the relay's presence report, which decays to "last
    // seen" rather than claiming anything once it goes stale).
    const health = active && activeHealth ? activeHealth : unlinkedMachineHealth(device);
    return (
      <SettingsRow
        key={device.id}
        leftSection={<MachineDot health={health} />}
        label={
          <Group gap={6}>
            {renaming?.id === device.id ? (
              <TextInput
                size="xs"
                value={renaming.name}
                autoFocus
                maxLength={64}
                onChange={(e) => setRenaming({ id: device.id, name: e.currentTarget.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void rename();
                  if (e.key === 'Escape') setRenaming(null);
                }}
                rightSection={
                  <Group gap={2} wrap="nowrap">
                    <ActionIcon size="xs" variant="subtle" onClick={() => void rename()} aria-label="Save name">
                      <IconCheck size={13} />
                    </ActionIcon>
                    <ActionIcon size="xs" variant="subtle" color="gray" onClick={() => setRenaming(null)} aria-label="Cancel rename">
                      <IconX size={13} />
                    </ActionIcon>
                  </Group>
                }
                rightSectionWidth={52}
              />
            ) : (
              <Text inherit truncate>
                {device.name}
              </Text>
            )}
            {device.shared && (
              // Somebody else's computer. Named, because everything you
              // run there happens on their machine, as them.
              <Badge size="xs" color="grape" variant="light">
                {device.ownerProfile?.name ?? device.ownerProfile?.email ?? 'shared with you'}
              </Badge>
            )}
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
        }
        description={
          <>
            {device.platform ?? 'unknown platform'} · {health.label}
            {/* "offline" says the state; "seen 5m ago" says how stale it
                is. The unknown state already reads as the latter. */}
            {health.state !== 'unknown' && health.state !== 'online'
              ? ` · ${lastSeenLabel(device.lastSeenAt)}`
              : ''}
            {active && activity.running > 0 ? ` · ${activity.running} running` : ''}
            {active && activity.actionable > 0
              ? ` · ${activity.actionable} needs you`
              : ''}
          </>
        }
        control={
          <Group gap={4} wrap="nowrap">
            {!active && (
              <Button size="xs" variant="subtle" onClick={() => switchToDevice(device.id)}>
                Use this
              </Button>
            )}
            {/* Handing out access to somebody else's machine is not ours
                to do either — the same `shared` guard Rename and Revoke
                use, so the three cannot drift apart. */}
            {SHARING_ENABLED && !device.shared && (
              <Tooltip label="Share this machine" withArrow>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  onClick={() => setSharing(device)}
                  aria-label={`Share ${device.name}`}
                >
                  <IconUserPlus size={15} />
                </ActionIcon>
              </Tooltip>
            )}
            {/* Renaming somebody else's machine is not ours to do — the
                name belongs to its owner's account, not to this grant. */}
            {device.shared ? null : (
              <Tooltip label="Rename" withArrow>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  onClick={() => setRenaming({ id: device.id, name: device.name })}
                  aria-label={`Rename ${device.name}`}
                >
                  <IconPencil size={15} />
                </ActionIcon>
              </Tooltip>
            )}
            {/* The owner revokes; the guest leaves. Both end this browser's
                access to the machine and neither touches the machine
                itself — but only one of them is the caller's to do, so the
                row shows exactly one. */}
            {device.shared ? (
              <Tooltip
                label="Leave this machine — you lose access to it until its owner shares it again"
                withArrow
                multiline
                w={260}
              >
                <ActionIcon
                  variant="subtle"
                  color="red"
                  loading={busyId === device.id}
                  onClick={() => void leave(device)}
                  aria-label={`Leave ${device.name}`}
                >
                  <IconLogout size={16} />
                </ActionIcon>
              </Tooltip>
            ) : (
              <Tooltip label="Revoke access" withArrow>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  loading={busyId === device.id}
                  onClick={() => setConfirmRevoke(device)}
                  aria-label={`Revoke ${device.name}`}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        }
      />
    );
  };

  const own = devices?.filter((device) => !device.shared) ?? [];
  const sharedWithMe = devices?.filter((device) => device.shared) ?? [];

  return (
    <>
      {error && (
        <Alert color="red" icon={<IconAlertCircle size={16} />} variant="light">
          {error}
        </Alert>
      )}

      {!devices ? (
        <Group justify="center" p="md">
          <Loader size="sm" />
        </Group>
      ) : (
        <>
          {/* What sharing and revoking actually do stays in view under the rows
              that do them: both are about who can reach this computer. */}
          <SettingsGroup
            title="Your machines"
            footer="Sharing a machine lets someone else use it with their own account, on your team or not; the agent still runs on your computer. Revoking stops a machine reconnecting and ends an open connection within a few minutes; it then shows a fresh pairing code, so you can add it back."
          >
            {own.length === 0 ? (
              <SettingsRow
                label={
                  <Text span inherit c="dimmed">
                    No machines paired yet.
                  </Text>
                }
              />
            ) : (
              own.map(renderDevice)
            )}
          </SettingsGroup>
          {sharedWithMe.length > 0 && (
            <SettingsGroup title="Shared with you">{sharedWithMe.map(renderDevice)}</SettingsGroup>
          )}
        </>
      )}

      {/* No `session` prop: the dialog opens in machine scope, which is the whole
          point of reaching it from here. */}
      {sharing && (
        <ShareModal
          opened
          onClose={() => setSharing(null)}
          deviceId={sharing.id}
          machineName={sharing.name}
        />
      )}

      {pairing ? (
        <SettingsGroup title="Pair a machine">
          <SettingsRow
            label="Pairing code"
            htmlFor={codeId}
            description="Run the Lines desktop app on the machine you want to add. It shows a pairing code on first launch."
          >
            {/* The same download surface as the connect gate: this panel's copy also
                assumed the app was already installed on the new machine. */}
            <DownloadDesktopApp />
            <Group gap="xs" wrap="nowrap">
              <TextInput
                id={codeId}
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
              Codes expire 15 minutes after the app shows one; it fetches a fresh one on its own.
            </Text>
          </SettingsRow>
        </SettingsGroup>
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

      <ConfirmModal
        opened={confirmRevoke !== null}
        title="Revoke this machine?"
        message={`${confirmRevoke?.name ?? 'The machine'} stops reconnecting, and a connection that is already open ends within a few minutes. The machine then shows a fresh pairing code, so you can add it back.`}
        confirmLabel="Revoke"
        confirmColor="red"
        confirmLoading={confirmRevoke !== null && busyId === confirmRevoke.id}
        onConfirm={() => {
          if (confirmRevoke) void revoke(confirmRevoke).then(() => setConfirmRevoke(null));
        }}
        onCancel={() => setConfirmRevoke(null)}
      />
    </>
  );
}
