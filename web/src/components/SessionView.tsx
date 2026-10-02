import { lazy, Suspense, useEffect, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  Menu,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconCheck,
  IconDots,
  IconFileDiff,
  IconFolder,
  IconGitBranch,
  IconLogin,
  IconPlayerPlay,
  IconShare,
  IconPlayerSkipForward,
  IconRefresh,
} from '@tabler/icons-react';
import { findWorktree, hasEstimatedSpend, isSessionActive } from '@lines/shared';
import { useStore } from '../store';
import { formatSpendUsd, skippableFailedStep } from '../lib/format';
import { useIsPhone } from '../lib/layout';
import { useStepResolver } from '../lib/useStepResolver';
import { send } from '../ws';
import { Transcript } from './Transcript';
import { Composer } from './Composer';
import { QueuedMessages } from './QueuedMessages';
import { WorkflowStepper } from './WorkflowStepper';
import { ShareModal } from './ShareModal';
import { MachineDot } from './MachineDot';
import { PresenceStack } from './PresenceStack';
import { linkedMachineHealth } from '../lib/machineHealth';
import { PRESET_COPY } from '../lib/shares';
import { useClaudeLoginNeeded, useSessionMachine, useSessionMachineHealth } from '../lib/can';
import { SHARING_ENABLED } from '../lib/shares';
import { rememberedDeviceId } from '../lib/storage';
import { useDevices } from '../lib/devices';
import { presetOfCaps } from '@lines/shared';

// See MonacoPreviewModal: lazy, so the review editor's Monaco is fetched when a
// review is opened rather than sitting in the entry chunk. The module imports
// `lib/monacoSetup` itself, which is what still orders the CDN override ahead
// of the first mount.
const SessionDiffModal = lazy(() =>
  import('./SessionDiffModal').then((m) => ({ default: m.SessionDiffModal })),
);

/** Past this, the wait is worth explaining and a manual re-send is offered. */
const SLOW_LOAD_MS = 8000;

/**
 * Stand-in for the transcript while its first load is outstanding. The reason
 * line follows the same precedence as the machine dot: the link, then the
 * bridge, then the worker — so a merely reconnecting link never reads "offline".
 */
function TranscriptLoading({
  health,
  ownerName,
  requestedAt,
  onRetry,
}: {
  health: ReturnType<typeof useSessionMachineHealth>;
  ownerName: string | null;
  requestedAt: number | null;
  onRetry: () => void;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (requestedAt == null) return;
    const t = setTimeout(() => setSlow(true), Math.max(0, requestedAt + SLOW_LOAD_MS - Date.now()));
    return () => clearTimeout(t);
  }, [requestedAt]);

  const reason = !health.connected
    ? `Connecting to ${ownerName ? `${ownerName}’s machine` : 'your machine'}…`
    : !health.bridgeAttached
      ? linkedMachineHealth(health).block
      : health.worker?.connected === false
        ? 'Machine’s worker is restarting…'
        : 'Loading transcript…';

  return (
    <Stack flex={1} mih={0} align="center" justify="center" gap="xs" px="md">
      <Group gap="xs" wrap="nowrap">
        <Loader size="sm" />
        <Text size="sm" c="dimmed">
          {reason}
        </Text>
      </Group>
      {slow && health.connected && (
        <>
          <Text size="xs" c="dimmed" ta="center" maw={420}>
            Taking longer than usual — the machine may be waking from sleep or the transcript is large.
          </Text>
          <Button size="compact-xs" variant="light" leftSection={<IconRefresh size={12} />} onClick={onRetry}>
            Retry
          </Button>
        </>
      )}
    </Stack>
  );
}

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
  // Own workflows first, then shared ones: a run of someone else's published
  // workflow gets its stepper too. The same lookup the composer uses.
  const { findWorkflow } = useStepResolver();
  const loggedOut = useClaudeLoginNeeded();
  const openLoginModal = useStore((s) => s.openLoginModal);
  const connected = useStore((s) => s.connectionStatus === 'connected');
  const projects = useStore((s) => s.projects);
  const clipboard = useClipboard({ timeout: 1500 });

  // Gated on the session's own link: `send` drops a non-prompt message on a dead
  // link, and with `loaded` still unset nothing would ever re-send it — the
  // transcript stayed blank until the session was re-picked. Keying on
  // `connected` re-sends on every reconnect instead.
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  useEffect(() => {
    setRequestedAt(null);
  }, [sessionId]);
  useEffect(() => {
    if (loaded || !health.connected) return;
    if (send({ type: 'loadTranscript', sessionId })) setRequestedAt(Date.now());
  }, [sessionId, loaded, health.connected]);
  const retryLoad = () => {
    if (send({ type: 'loadTranscript', sessionId })) setRequestedAt(Date.now());
  };

  // Layout only: what the header can hold at 390px. Never a second decision
  // path — both branches call the same handlers.
  const isPhone = useIsPhone();

  if (!session) return null;
  // Both halves matter: the server says a sign-in is required, and the client
  // still is signed out — so a re-login elsewhere retires the button with no
  // server sweep.
  const needsSignIn = session.errorKind === 'auth' && loggedOut;
  // A failed workflow step can be skipped instead of retried — the same Approve
  // the stepper sends, offered where the failure is actually reported.
  const skipStep = skippableFailedStep(session);
  // An inline snapshot (a guest's own workflow) wins: it is not in any library here.
  const workflow = session.workflow
    ? (session.workflow.def ?? findWorkflow(session.workflow.workflowId))
    : undefined;
  // A work-tree session is confined to that checkout, which the path alone doesn't
  // say — the branch is what makes it identifiable at a glance.
  const worktree = findWorktree(projects, session.cwd)?.worktree;
  const deviceId = rememberedDeviceId();
  // Named in the modal title, so "share the whole machine" says which machine.
  const machineName = devices?.find((d) => d.id === deviceId)?.name ?? null;

  return (
    <Stack gap={0} h="100%">
      {/* One line at any width: the name side shrinks and ellipsizes, the
          trailing actions never wrap under it. */}
      <Group px="md" py={8} justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
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
          <Text fw={600} size="sm" truncate style={{ minWidth: 0 }}>
            {session.name}
          </Text>
          {worktree && (
            <Group gap={3} wrap="nowrap" c="dimmed" style={{ flexShrink: 0 }}>
              <IconGitBranch size={12} />
              <Text size="xs">{worktree.branch ?? 'detached'}</Text>
            </Group>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
          <PresenceStack sessionId={sessionId} />
          {/* Phone: the two icon buttons and the cost read-out do not fit beside
              a session name at 390px, so they fold into one menu. Same actions,
              same handlers — a second decision path here is how the two would
              drift. */}
          {isPhone ? (
            <Menu position="bottom-end" width={220} withinPortal>
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Session actions">
                  <IconDots size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {session.lastCostUsd != null && (
                  <Menu.Label>
                    last turn{' '}
                    {formatSpendUsd(session.lastCostUsd, hasEstimatedSpend(session.costByModel))}
                  </Menu.Label>
                )}
                <Menu.Item leftSection={<IconFileDiff size={14} />} onClick={() => setReviewing(true)}>
                  Review changes
                </Menu.Item>
                {!access && SHARING_ENABLED && (
                  <Menu.Item leftSection={<IconShare size={14} />} onClick={() => setSharing(true)}>
                    Share session
                  </Menu.Item>
                )}
              </Menu.Dropdown>
            </Menu>
          ) : (
            <>
          {session.lastCostUsd != null && (
            <Text size="xs" c="dimmed">
              last turn {formatSpendUsd(session.lastCostUsd, hasEstimatedSpend(session.costByModel))}
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
            </>
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
      {/* Only while there is nothing cached to show: a reconnect reload keeps
          the transcript on screen. Without this gate an unloaded session claimed
          "Send a prompt to start." — indistinguishable from a dead one. */}
      {!loaded && !events?.length ? (
        <TranscriptLoading
          health={health}
          ownerName={remote.isRemote ? (remote.ownerProfile?.name ?? null) : null}
          requestedAt={requestedAt}
          onRetry={retryLoad}
        />
      ) : (
        <Transcript sessionId={sessionId} events={events ?? []} stepCount={workflow?.steps.length} />
      )}
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
        <Suspense fallback={null}>
          <SessionDiffModal opened={reviewing} onClose={() => setReviewing(false)} sessionId={sessionId} />
        </Suspense>
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
