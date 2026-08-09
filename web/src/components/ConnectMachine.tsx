import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Center,
  Code,
  List,
  Loader,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertCircle, IconDeviceLaptop } from '@tabler/icons-react';
import { claimDevice } from '../lib/storage';

/**
 * Shown when a signed-in user has no paired machine, which is the only state in
 * which the hosted app cannot do anything at all: the agent runs on the user's
 * own computer, so with no machine there is nothing to connect a session to.
 *
 * Pairing is deliberately code-based rather than a link: the machine registers
 * itself before any user is involved (it cannot know who is signing in), so the
 * code is what carries the user's intent across to it.
 */
export function ConnectMachine({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await claimDevice(code);
      onPaired();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Center h="100vh" p="md">
      <Card withBorder radius="md" p="xl" maw={560} w="100%">
        <Stack gap="md">
          <Stack gap={4} align="center">
            <IconDeviceLaptop size={32} />
            <Title order={3}>Connect a machine</Title>
            <Text size="sm" c="dimmed" ta="center">
              Lines runs the agent on your own computer, so it can read and edit your
              files. This site is the interface; your machine does the work.
            </Text>
          </Stack>

          <List size="sm" spacing={6} type="ordered">
            <List.Item>
              Run the Lines desktop app on the machine you want to use.
            </List.Item>
            <List.Item>It prints a pairing code on first launch.</List.Item>
            <List.Item>Enter that code below.</List.Item>
          </List>

          <TextInput
            label="Pairing code"
            placeholder="XXXXXXXX"
            value={code}
            // Uppercased as typed: the alphabet has no lowercase, and silently
            // fixing it beats rejecting a correctly-read code.
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

          <Button onClick={() => void submit()} disabled={!code.trim() || busy}>
            {busy ? 'Pairing…' : 'Pair this machine'}
          </Button>

          <Text size="xs" c="dimmed">
            Codes expire 15 minutes after the app prints one. Restart the desktop app to
            get a fresh code.
          </Text>
        </Stack>
      </Card>
    </Center>
  );
}

/** Full-page spinner while the device list is in flight — the gate cannot decide without it. */
export function ConnectMachineLoading() {
  return (
    <Center h="100vh">
      <Loader />
    </Center>
  );
}

/**
 * The device list itself failed. Distinct from "no devices": retrying is the
 * right action here, and showing the pairing form would be a lie — we do not
 * know whether a machine is already paired.
 */
export function ConnectMachineError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <Center h="100vh" p="md">
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
    </Center>
  );
}
