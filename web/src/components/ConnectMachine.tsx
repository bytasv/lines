import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Code,
  List,
  Loader,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { claimDevice } from '../lib/storage';
import { useDevices } from '../lib/devices';
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

        <Card withBorder radius="md" p="md">
          <PairingDiagram />
        </Card>

        <Card withBorder radius="md" p="lg">
          <Stack gap="md">
            <List size="sm" spacing={6} type="ordered">
              <List.Item>Run the Lines desktop app on the machine you want to use.</List.Item>
              <List.Item>It prints a pairing code on first launch.</List.Item>
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
              Codes expire 15 minutes after the app prints one. Restart the desktop app for a
              fresh code.
            </Text>
          </Stack>
        </Card>
      </Stack>
    </GateShell>
  );
}

/** Full-page spinner while the machine list is in flight — the gate cannot decide without it. */
export function ConnectMachineLoading() {
  return (
    <GateShell>
      <Loader />
    </GateShell>
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
