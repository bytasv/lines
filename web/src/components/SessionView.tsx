import { useEffect } from 'react';
import { Alert, Divider, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useStore } from '../store';
import { send } from '../ws';
import { Transcript } from './Transcript';
import { Composer } from './Composer';
import { WorkflowStepper } from './WorkflowStepper';

export function SessionView({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const events = useStore((s) => s.transcripts[sessionId]);
  const loaded = useStore((s) => s.transcriptLoaded[sessionId]);
  const workflows = useStore((s) => s.workflows);

  useEffect(() => {
    if (!loaded) send({ type: 'loadTranscript', sessionId });
  }, [sessionId, loaded]);

  if (!session) return null;
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
          <Text size="xs">{session.errorMessage}</Text>
        </Alert>
      )}
      <Transcript sessionId={sessionId} events={events ?? []} stepCount={workflow?.steps.length} />
      <Composer session={session} />
    </Stack>
  );
}
