import { useEffect, useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Divider, Group, Loader, Stack, Text, Tooltip } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconCheck,
  IconFileDiff,
  IconFolder,
  IconGitBranch,
  IconLogin,
  IconPlayerPlay,
  IconShare,
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
import { ShareModal } from './ShareModal';
import { SessionDiffModal } from './SessionDiffModal';
import { MachineDot } from './MachineDot';
import { PresenceStack } from './PresenceStack';
import { linkedMachineHealth } from '../lib/machineHealth';
import { PRESET_COPY } from '../lib/shares';
import { useClaudeLoginNeeded, useSessionMachine, useSessionMachineHealth } from '../lib/can';
import { SHARING_ENABLED } from '../lib/shares';
import { rememberedDeviceId } from '../lib/storage';
import { useDevices } from '../lib/devices';
import { presetOfCaps } from '@lines/shared';

export function SessionView({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  // Null on your own machine. Present means this session is somebody else's, and
  // the header says so — typing into a colleague's laptop unaware is the failure
  // this exists to prevent.
  const access = useStore((s) => s.access);
  const [sharing, setSharing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const remote = useSessionMachine(sessionId);
  // The dot in this header describes the session's *own* machine, so a shared
  // session on a dead laptop is obvious before you type into it.
  const health = useSessionMachineHealth(sessionId);
  const devices = useDevices((d) => d.devices);
  const events = useStore((s) => s.transcripts[sessionId]);
  const loaded = useStore((s) => s.transcriptLoaded[sessionId]);
  const workflows = useStore((s) => s.workflows);
  const loggedOut = useClaudeLoginNeeded();
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
  const deviceId = rememberedDeviceId();
  // Named in the modal title, so "share the whole machine" says which machine.
  const machineName = devices?.find((d) => d.id === deviceId)?.name ?? null;

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
        <Group gap="xs" wrap="nowrap">
          <PresenceStack sessionId={sessionId} />
          {session.lastCostUsd != null && (
            <Text size="xs" c="dimmed">
              last turn ${session.lastCostUsd.toFixed(4)}
            </Text>
          )}
          {/* Opens on click rather than prefetching a count: the diff is a `git
              diff` per repo, and paying for one every time a session is selected
              would be a poor trade for a badge. */}
          <Tooltip label="Review this session’s changes" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Review this session’s changes"
              onClick={() => setReviewing(true)}
            >
              <IconFileDiff size={14} />
            </ActionIcon>
          </Tooltip>
          {/* Owner only: sharing somebody else's session is not a grant anyone
              holds, and there is no storage to record a grant in a local install. */}
          {!access && SHARING_ENABLED && (
            <Tooltip label="Share this session" withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Share this session"
                onClick={() => setSharing(true)}
              >
                <IconShare size={14} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Group>
      {/* A persistent bar, not a toast: which machine a session runs on, and what
          you may do there, has to be true for as long as you are looking at it.
          Deliberately not one of the global banners — those keep their own
          "exactly one at a time" precedence for the primary machine. */}
      {(access || remote.isRemote) && (
        <>
          <Divider />
          <Group px="md" py={6} gap="xs" wrap="nowrap" bg="var(--mantine-color-default-hover)">
            <MachineDot
              health={linkedMachineHealth({
                bridgeAttached: health.bridgeAttached,
                worker: health.worker,
                storage: health.storage,
              })}
            />
            <Text size="xs" c="dimmed">
              Running on{' '}
              {remote.ownerProfile?.name ??
                access?.ownerProfile?.name ??
                access?.ownerProfile?.email ??
                'another person'}
              ’s machine
            </Text>
            {access && (
              <Badge size="xs" variant="light" color="gray">
                {presetOfCaps(access.caps, access.scope)
                  ? PRESET_COPY[presetOfCaps(access.caps, access.scope)!].label
                  : 'custom access'}
              </Badge>
            )}
          </Group>
        </>
      )}
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
      {/* The live truth about work that outlived the turn. The transcript keeps its
          own task rows, but those are a record — this strip is what a page reload
          rebuilds from, and what tells you the session is not as idle as it reads.
          A background agent can sit running for minutes before its first nested
          message lands, so the description is the only thing to show. */}
      {!!session.backgroundTasks?.length && (
        <Group px="md" py={6} gap={6} wrap="nowrap" bg="var(--mantine-color-default-hover)">
          <Loader size={12} />
          <Text size="xs" c="dimmed" truncate>
            {session.backgroundTasks.length === 1
              ? '1 background task'
              : `${session.backgroundTasks.length} background tasks`}
            {' · '}
            {session.backgroundTasks.map((t) => t.description).join(', ')}
          </Text>
        </Group>
      )}
      <QueuedMessages session={session} />
      <Composer session={session} />
      {reviewing && (
        <SessionDiffModal opened={reviewing} onClose={() => setReviewing(false)} sessionId={sessionId} />
      )}
      {sharing && deviceId && (
        <ShareModal
          opened={sharing}
          onClose={() => setSharing(false)}
          deviceId={deviceId}
          machineName={machineName}
          session={{ id: session.id, name: session.name }}
        />
      )}
    </Stack>
  );
}
