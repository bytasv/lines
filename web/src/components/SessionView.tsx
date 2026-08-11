import { useEffect } from 'react';
import { Alert, Button, Divider, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconLogin, IconPlayerPlay, IconRefresh } from '@tabler/icons-react';
import { isSessionActive } from '@lines/shared';
import { useStore } from '../store';
import { send } from '../ws';
import { Transcript } from './Transcript';
import { Composer } from './Composer';
import { QueuedMessages } from './QueuedMessages';
import { WorkflowStepper } from './WorkflowStepper';

export function SessionView({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const events = useStore((s) => s.transcripts[sessionId]);
  const loaded = useStore((s) => s.transcriptLoaded[sessionId]);
  const workflows = useStore((s) => s.workflows);
  const loggedOut = useStore((s) => s.auth?.loggedIn === false);
  const openLoginModal = useStore((s) => s.openLoginModal);

  useEffect(() => {
    if (!loaded) send({ type: 'loadTranscript', sessionId });
  }, [sessionId, loaded]);

  if (!session) return null;
  // Both halves matter: the server says a sign-in is required, and the client
  // still is signed out — so a re-login elsewhere retires the button with no
  // server sweep.
  const needsSignIn = session.errorKind === 'auth' && loggedOut;
  const workflow = session.workflow
    ? workflows.find((w) => w.id === session.workflow!.workflowId)
    : undefined;

  return (
    <Stack gap={0} h="100%">
      <Group px="md" py={8} justify="space-between">
        <Group gap="xs">
          <Text fw={600} size="sm">
            {session.name}
          </Text>
          <Text size="xs" c="dimmed" ff="monospace">
            {session.cwd}
          </Text>
        </Group>
        {session.lastCostUsd != null && (
          <Text size="xs" c="dimmed">
            last turn ${session.lastCostUsd.toFixed(4)}
          </Text>
        )}
      </Group>
      <Divider />
      {workflow && session.workflow && <WorkflowStepper session={session} workflow={workflow} />}
      {session.status === 'error' && session.errorMessage && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} m="md" py={6}>
          <Group gap="sm" wrap="nowrap" justify="space-between">
            <Text size="xs">{session.errorMessage}</Text>
            <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
              {needsSignIn && (
                <Button
                  size="compact-xs"
                  color="red"
                  leftSection={<IconLogin size={12} />}
                  onClick={openLoginModal}
                >
                  Sign in
                </Button>
              )}
              <Button
                size="compact-xs"
                variant="light"
                color="red"
                leftSection={<IconRefresh size={12} />}
                onClick={() => send({ type: 'retryTurn', sessionId })}
              >
                Retry
              </Button>
            </Group>
          </Group>
        </Alert>
      )}
      {session.interruptedAt && !isSessionActive(session.status) && session.status !== 'error' && (
        <Alert color="yellow" icon={<IconPlayerPlay size={16} />} m="md" py={6}>
          <Group gap="sm" wrap="nowrap" justify="space-between">
            <Text size="xs">
              This session was interrupted mid-task when the app closed. The agent can pick up where it left off.
            </Text>
            <Button
              size="compact-xs"
              variant="light"
              color="yellow"
              style={{ flexShrink: 0 }}
              onClick={() => send({ type: 'continueTurn', sessionId })}
            >
              Continue
            </Button>
          </Group>
        </Alert>
      )}
      <Transcript sessionId={sessionId} events={events ?? []} stepCount={workflow?.steps.length} />
      <QueuedMessages session={session} />
      <Composer session={session} />
    </Stack>
  );
}
