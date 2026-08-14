import { useEffect } from 'react';
import { ActionIcon, Alert, Button, Divider, Group, Stack, Text, Tooltip } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconCheck,
  IconFolder,
  IconGitBranch,
  IconLogin,
  IconPlayerPlay,
  IconPlayerSkipForward,
  IconRefresh,
} from '@tabler/icons-react';
import { findWorktree, isSessionActive } from '@lines/shared';
import { useStore } from '../store';
import { skippableFailedStep } from '../lib/format';
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
  const connected = useStore((s) => s.connectionStatus === 'connected');
  const projects = useStore((s) => s.projects);
  const clipboard = useClipboard({ timeout: 1500 });

  useEffect(() => {
    if (!loaded) send({ type: 'loadTranscript', sessionId });
  }, [sessionId, loaded]);

  if (!session) return null;
  // Both halves matter: the server says a sign-in is required, and the client
  // still is signed out — so a re-login elsewhere retires the button with no
  // server sweep.
  const needsSignIn = session.errorKind === 'auth' && loggedOut;
  // A failed workflow step can be skipped instead of retried — the same Approve
  // the stepper sends, offered where the failure is actually reported.
  const skipStep = skippableFailedStep(session);
  const workflow = session.workflow
    ? workflows.find((w) => w.id === session.workflow!.workflowId)
    : undefined;
  // A work-tree session is confined to that checkout, which the path alone doesn't
  // say — the branch is what makes it identifiable at a glance.
  const worktree = findWorktree(projects, session.cwd)?.worktree;

  return (
    <Stack gap={0} h="100%">
      <Group px="md" py={8} justify="space-between">
        <Group gap="xs">
          {/* Ahead of the name, where the path used to trail it: this is the one
              control in the header, and a leading icon reads as one. The path itself
              is noise — a managed work tree's is long and says nothing the branch
              doesn't — but it stays one click away, since it is what you paste into a
              terminal to get there. */}
          <Tooltip
            label={clipboard.copied ? 'Copied' : `${session.cwd} — click to copy`}
            openDelay={200}
            multiline
            maw={420}
            styles={{ tooltip: { wordBreak: 'break-all' } }}
          >
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Copy working directory"
              onClick={() => clipboard.copy(session.cwd)}
            >
              {clipboard.copied ? <IconCheck size={13} /> : <IconFolder size={13} />}
            </ActionIcon>
          </Tooltip>
          <Text fw={600} size="sm">
            {session.name}
          </Text>
          {worktree && (
            <Group gap={3} wrap="nowrap" c="dimmed">
              <IconGitBranch size={12} />
              <Text size="xs">{worktree.branch ?? 'detached'}</Text>
            </Group>
          )}
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
              {skipStep !== null && (
                <Button
                  size="compact-xs"
                  variant="light"
                  color="red"
                  leftSection={<IconPlayerSkipForward size={12} />}
                  // ws.ts silently drops non-prompt messages on a closed socket.
                  disabled={!connected}
                  onClick={() => send({ type: 'workflowApprove', sessionId, stepIndex: skipStep })}
                >
                  Skip step
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
