import { useEffect, useState } from 'react';
import {
  Alert,
  Avatar,
  Button,
  Card,
  Code,
  Divider,
  Group,
  List,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { claimDevice } from '../lib/storage';
import { useDevices } from '../lib/devices';
import {
  PRESET_COPY,
  SHARING_ENABLED,
  claimInvite,
  pendingInvites,
  type PendingInvite,
} from '../lib/shares';
import { rememberDeviceId } from '../lib/storage';
import { switchDevice } from '../ws';
import { adoptJoinGrant } from '../lib/e2ee';
import { DownloadDesktopApp } from './DownloadDesktopApp';
import { GateShell } from './GateShell';
import { PairingDiagram } from './PairingDiagram';

/**
 * Shown when a signed-in user has no machine to connect to — either they have
 * never paired one, or the one they were using was revoked. It is the only state
 * in which the hosted app can do nothing at all: the agent runs on the user's own
 * computer, so with no machine there is no session to open.
 *
 * Pairing is code-based rather than a link because the machine registers itself
 * before any user is involved — it cannot know who is signing in — so the code is
 * what carries the user's intent across to it.
 */
export function ConnectMachine() {
  const refresh = useDevices((s) => s.refresh);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await claimDevice(code);
      // The gate re-renders off this list, so a successful claim is what takes
      // the user into the app — no navigation involved.
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <GateShell>
      <Stack gap="lg" maw={680} w="100%">
        <Stack gap={4}>
          <Title order={3}>Connect a machine</Title>
          <Text size="sm" c="dimmed">
            Lines runs the agent on your own computer, so it can read and edit your files.
            This site is the interface; your machine does the work.
          </Text>
        </Stack>

        {/* Before the pairing instructions, because an invitee needs no machine
            of their own at all — telling them to install a desktop app first
            would be answering a question they never asked. */}
        <PendingInvitations />

        <Card withBorder radius="md" p="md">
          <PairingDiagram />
        </Card>

        {/* Above the steps on purpose: step one is impossible without the app,
            and this is a user who demonstrably has no machine yet. */}
        <DownloadDesktopApp />

        <Card withBorder radius="md" p="lg">
          <Stack gap="md">
            <List size="sm" spacing={6} type="ordered">
              <List.Item>Run the Lines desktop app on the machine you want to use.</List.Item>
              <List.Item>It shows a pairing code on first launch.</List.Item>
              <List.Item>Enter that code here.</List.Item>
            </List>

            <TextInput
              label="Pairing code"
              placeholder="XXXXXXXX"
              value={code}
              // Uppercased as typed: the code alphabet has no lowercase, and
              // quietly fixing the case beats rejecting a correctly-read code.
              onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              disabled={busy}
              autoFocus
            />

            {error && (
              <Alert color="red" icon={<IconAlertCircle size={16} />} variant="light">
                {error}
              </Alert>
            )}

            <Button onClick={() => void submit()} disabled={!code.trim() || busy} loading={busy}>
              Pair this machine
            </Button>

            <Text size="xs" c="dimmed">
              Codes expire 15 minutes after the app shows one. The app fetches a fresh code on its
              own — or pick “Get a new code” from its menu-bar icon.
            </Text>
          </Stack>
        </Card>
      </Stack>
    </GateShell>
  );
}

/**
 * Invitations waiting for this user, offered here because this screen is where an
 * invitee lands if they sign in before opening their link — or after losing it.
 *
 * Without this the screen is a dead end for them: it asks them to install Lines
 * and pair a computer, when what they actually hold is access to somebody else's.
 * Renders nothing at all when there are none, so the ordinary pairing flow is
 * untouched.
 */
function PendingInvitations() {
  const refresh = useDevices((s) => s.refresh);
  const [invites, setInvites] = useState<PendingInvite[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!SHARING_ENABLED) return;
    // Failure is silent: this is an extra affordance, and an error here must not
    // bury the pairing form that is this screen's actual job.
    pendingInvites()
      .then((r) => setInvites(r.invites))
      .catch(() => setInvites([]));
  }, []);

  const accept = async (invite: PendingInvite) => {
    setBusy(invite.code);
    setError(null);
    try {
      const { deviceId } = await claimInvite(invite.code);
      // The machine admits a guest only on the grant from the invite link. If this
      // tab opened that link before signing in, its grant is waiting to be taken
      // up; without it the machine will say to open the link again.
      adoptJoinGrant(deviceId, invite.code);
      rememberDeviceId(deviceId);
      switchDevice(deviceId);
      // The gate re-renders off the device list, so this is what takes them in.
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  if (!invites?.length) return null;

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Stack gap={2}>
          <Title order={5}>You’ve been invited</Title>
          <Text size="sm" c="dimmed">
            You don’t need a machine of your own to accept — the work runs on theirs.
          </Text>
        </Stack>
        {error && (
          <Alert color="red" icon={<IconAlertCircle size={16} />} variant="light">
            {error}
          </Alert>
        )}
        {invites.map((invite) => {
          const who = invite.owner?.name ?? invite.owner?.email ?? 'Someone';
          return (
            <Group key={invite.code} gap="sm" wrap="nowrap">
              <Avatar src={invite.owner?.imageUrl ?? undefined} radius="xl" size={32}>
                {who.slice(0, 1).toUpperCase()}
              </Avatar>
              <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" truncate>
                  {who} shared {invite.scope === 'session' ? 'a session' : 'their machine'}
                  {invite.machineName ? ` on ${invite.machineName}` : ''}
                </Text>
                {invite.preset && (
                  <Text size="xs" c="dimmed" truncate>
                    {PRESET_COPY[invite.preset].label} · {PRESET_COPY[invite.preset].detail}
                  </Text>
                )}
              </Stack>
              <Button
                size="xs"
                onClick={() => void accept(invite)}
                loading={busy === invite.code}
                disabled={busy !== null}
              >
                Accept
              </Button>
            </Group>
          );
        })}
        <Divider />
        <Text size="xs" c="dimmed">
          Or pair a machine of your own below.
        </Text>
      </Stack>
    </Card>
  );
}

/**
 * The machine list itself failed. Distinct from "no machines": retrying is the
 * right action, and showing the pairing form would be a lie — we do not know
 * whether a machine is already paired.
 */
export function ConnectMachineError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <GateShell>
      <Card withBorder radius="md" p="xl" maw={520} w="100%">
        <Stack gap="md">
          <Title order={4}>Can’t reach Lines storage</Title>
          <Text size="sm" c="dimmed">
            Your machines could not be listed, so there is no way to tell which one to
            connect to.
          </Text>
          <Code block>{error}</Code>
          <Button onClick={onRetry}>Try again</Button>
        </Stack>
      </Card>
    </GateShell>
  );
}
