import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Alert,
  Button,
  Card,
  Group,
  List,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import {
  IconCopy,
  IconDeviceLaptop,
  IconLock,
  IconSend,
  IconPlus,
  IconRefresh,
  IconUnlink,
} from '@tabler/icons-react';
import { ENROLL_CODE_LENGTH, normalizeEnrollCode } from '@lines/shared';
import { sendDiagnostics, type Device } from '../lib/storage';
import { cryptoUnavailable, takeEnrollCodeFromUrl } from '../lib/e2ee';
import { enrollWithCode, linkDiagnostics, type LinkDiagnostics } from '../ws';
import { diag, diagReport, markDiagSent } from '../lib/diag';
import { unlinkedMachineHealth } from '../lib/machineHealth';
import { useSplash } from '../lib/splash';
import { useStore } from '../store';
import { MachineDot } from './MachineDot';
import { GateHint, GateShell } from './GateShell';
import { UserMenu } from './UserMenu';

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

  // The marker the auto-upload keys on (see ws.ts), and the one line that says
  // what the link was doing when the user started waiting.
  useEffect(() => {
    if (!slow) return;
    const link = linkDiagnostics(deviceId);
    diag('connecting-slow', {
      device: deviceId,
      status,
      offline,
      phase: link.phase,
      stage: link.stage,
      phaseMs: link.since === null ? null : Date.now() - link.since,
      attempts: link.attempts,
      lastCloseCode: link.lastClose?.code ?? null,
    });
    // Once per stall, not per status flicker: status/offline deliberately omitted.
  }, [slow, deviceId]);

  // Named, because the whole point of the split is that the work happens on a
  // specific computer of theirs. Held from here rather than rendered: the splash
  // that started at first paint stays up, so its loop runs straight through.
  const slot = useSplash(
    refusal
      ? null
      : offline
        ? `${name} is not connected right now`
        : status === 'connected'
          ? 'Loading your sessions and projects…'
          : `Connecting to ${name}…`,
  );

  const reconnect = async () => {
    setBusy(true);
    try {
      await onReconnect();
    } finally {
      setBusy(false);
    }
  };

  if (refusal) {
    return (
      <EnrollGate
        name={name}
        reason={refusal}
        deviceId={deviceId}
        others={others}
        onSwitch={onSwitch}
        onPairNew={onPairNew}
      />
    );
  }

  if (!offline && !slow) return null;

  // Only the escalation is React's, rendered into the slot under the caption.
  const help = (
    <>
      {/* The splash has no header, and without the account menu this screen is
          a dead end for anyone signed in as the wrong account (see GateShell). */}
      <div className="lines-splash-account">
        <UserMenu />
      </div>
      <Stack className="lines-splash-panel" align="center" gap="xs" mt="lg" maw={420} mx="auto">
        {offline ? (
          <GateHint>
            Lines is not running on {name}, or the machine is asleep. Wake it and open Lines, then reconnect.
          </GateHint>
        ) : (
          <SlowHint deviceId={deviceId} name={name} />
        )}

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

        <DiagnosticsFooter deviceId={deviceId} />
      </Stack>
    </>
  );
  return slot ? createPortal(help, slot) : help;
}

/**
 * Why a connection is slow, read off what the link is doing. Only the states in
 * which the machine has not been heard from are reason to suspect it: once it has
 * answered, the wait is the network's, and sending the user to check a computer
 * that is fine helps nobody.
 */
function slowHint(link: LinkDiagnostics, name: string): string {
  if (link.phase === 'connecting') return 'Still signing you in. Your network may be slow.';
  if (link.phase === 'socket-connecting') return 'Still connecting. Your network may be slow.';
  if (link.stage === 'handshake') return `Setting up an encrypted connection to ${name}. Your network may be slow.`;
  if (link.stage === 'hello') {
    return link.encrypted
      ? `${name} answered and is sending your sessions. This network is slow, so it can take a while.`
      : `Waiting for ${name} to send your sessions. Your network may be slow.`;
  }
  return `Taking longer than usual. Check that Lines is running on ${name} and that the machine is awake.`;
}

/** Re-reads the link every second: nothing in the store announces its progress. */
function SlowHint({ deviceId, name }: { deviceId: string; name: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <GateHint>{slowHint(linkDiagnostics(deviceId), name)}</GateHint>;
}

function describeLink(d: LinkDiagnostics, now: number): string {
  const secs = d.since === null ? null : Math.round((now - d.since) / 1000);
  const age = secs === null ? '' : ` ${secs}s`;
  const tries = d.attempts > 1 ? ` · attempt ${d.attempts}` : '';
  const close = d.lastClose ? ` · last close ${d.lastClose.code}${d.lastClose.reason ? ` ${d.lastClose.reason}` : ''}` : '';
  const open =
    d.stage === 'live' ? 'connected' : d.stage === 'hello' ? 'channel ready, waiting for hello' : 'socket open, encrypting';
  const phase = {
    connecting: 'waiting for sign-in token',
    'socket-connecting': 'opening socket',
    open,
    closed: 'socket closed',
    none: 'no socket',
  }[d.phase];
  return `${phase}${age}${tries}${close}`;
}

/**
 * What the link is doing right now, and a way to hand the record to whoever is
 * debugging — uploaded, or copied when the upload itself can't get through.
 */
function DiagnosticsFooter({ deviceId }: { deviceId: string }) {
  const [now, setNow] = useState(() => Date.now());
  const [sent, setSent] = useState<'idle' | 'sending' | 'sent' | 'failed' | 'copied'>('idle');

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const upload = async () => {
    setSent('sending');
    const at = Date.now();
    try {
      await sendDiagnostics(deviceId);
      markDiagSent(at);
      setSent('sent');
    } catch (err) {
      diag('diag-upload-failed', { error: err instanceof Error ? err.message : String(err) });
      setSent('failed');
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diagReport());
      setSent('copied');
    } catch {
      setSent('failed');
    }
  };

  return (
    <Stack align="center" gap={4} mt="sm">
      <Text size="xs" c="dimmed" ta="center" ff="monospace">
        {describeLink(linkDiagnostics(deviceId), now)}
      </Text>
      <Group gap={6}>
        <Button
          variant="subtle"
          size="compact-xs"
          color="gray"
          leftSection={<IconSend size={12} />}
          loading={sent === 'sending'}
          onClick={() => void upload()}
        >
          {sent === 'sent' ? 'Diagnostics sent' : sent === 'failed' ? 'Send failed — copy instead' : 'Send diagnostics'}
        </Button>
        <Button
          variant="subtle"
          size="compact-xs"
          color="gray"
          leftSection={<IconCopy size={12} />}
          onClick={() => void copy()}
        >
          {sent === 'copied' ? 'Copied' : 'Copy'}
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * The way back in when a machine refuses this browser for want of a key.
 *
 * This screen has to exist, and it has to be *here*: a machine refuses every
 * relayed channel that cannot present a pinned key — from its first launch, with
 * nothing enrolled yet — so a new browser never loads the app, and Settings →
 * Encryption, the only other place to enrol, lives behind the app. Without this,
 * connecting any browser but the desktop app's own window would need a terminal.
 *
 * The socket behind this is deliberately silent (see `needsEnrollment` in
 * ws.ts): the enrollment frame is the only thing it may carry.
 */
function EnrollGate({
  name,
  reason,
  deviceId,
  others,
  onSwitch,
  onPairNew,
}: {
  name: string;
  reason: string;
  deviceId: string;
  /** Every other machine on the account. Without these, this screen is a dead
   *  end that never says which machine it is talking about or offers another. */
  others: Device[];
  onSwitch: (id: string) => void;
  onPairNew: () => void;
}) {
  // A code the machine handed this page — the desktop app's own window always
  // does, and a scanned QR does too. Read once, on mount, because reading it
  // also consumes it.
  const [handed] = useState(() => takeEnrollCodeFromUrl()?.code ?? '');
  const [code, setCode] = useState(handed);
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

  // Enrol without asking when the machine itself supplied the code. Typing a
  // code from this machine's tray into this machine's own window is ceremony
  // with no security value: the shell holds the private key already.
  useEffect(() => {
    if (handed && !busy && !error) void enroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handed]);

  return (
    <GateShell>
      <Stack align="center" gap="md" maw={460} w="100%">
        <IconLock size={36} stroke={1.4} />
        <Stack align="center" gap={4}>
          <Title order={4}>{name} needs this browser enrolled</Title>
          <GateHint>
            {handed
              ? `${name} handed this window a key. Setting it up…`
              : 'That machine only accepts browsers it has a key for, and this one has none yet. ' +
                'Enrol it once with a code from the machine and it connects from then on.'}
          </GateHint>
        </Stack>

        <Card withBorder radius="md" p="md" w="100%">
          <Stack gap="xs">
            {blocked && (
              <Alert color="orange" variant="light">
                {blocked}
              </Alert>
            )}
            {/* Numbered, because this is the one step in the product that asks
                the user to walk to another device. A paragraph describing it
                reads as an explanation; a list reads as something to do. */}
            <List size="xs" spacing={4} type="ordered" c="dimmed">
              <List.Item>
                On <strong>{name}</strong>, click the Lines icon in the menu bar.
              </List.Item>
              <List.Item>
                Choose <strong>Show encryption code…</strong>
              </List.Item>
              <List.Item>
                Scan the QR it shows with this device's camera, or type the code below.
              </List.Item>
            </List>
            <Text size="xs" c="dimmed">
              The code works once and expires in 15 minutes. It is never sent anywhere — only a
              proof computed from it — which is what keeps the server out of this exchange.
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

        {others.length > 0 && (
          <Stack align="stretch" gap={6} w="100%">
            <Text size="xs" c="dimmed" ta="center">
              Or use a different machine:
            </Text>
            {others.map((device) => {
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

        <Button variant="subtle" size="xs" leftSection={<IconPlus size={14} />} onClick={onPairNew}>
          Pair a different machine
        </Button>

        <Text size="xs" c="dimmed" ta="center">
          {reason}
        </Text>
      </Stack>
    </GateShell>
  );
}
