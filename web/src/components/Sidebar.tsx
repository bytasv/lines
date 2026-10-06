import {
  ActionIcon,
  Avatar,
  Badge,
  Box,
  Button,
  Center,
  Divider,
  Group,
  Loader,
  Menu,
  Popover,
  ScrollArea,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconArchive,
  IconArchiveOff,
  IconArrowsSort,
  IconBook,
  IconCircleCheck,
  IconCircleCheckFilled,
  IconChevronDown,
  IconCoins,
  IconDots,
  IconEye,
  IconEyeOff,
  IconGitBranch,
  IconLink,
  IconPlus,
  IconRoute,
  IconSearch,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useHotkeys, useLocalStorage } from '@mantine/hooks';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SessionMeta, WorkflowDef, WorkflowStepOverride } from '@lines/shared';
import { findWorktree, hasEstimatedSpend, projectPaths, projectRoots, rootsForCwd } from '@lines/shared';
import type { SessionSort } from '../lib/format';
import {
  compareSessions,
  formatDuration,
  formatSpendUsd,
  isWorkflowFinished,
  SESSION_SORT_KEY,
  sessionRowMeta,
  withLiveSpend,
} from '../lib/format';
import { useCan, useCanOnSession, useSessionMachine } from '../lib/can';
import { searchSessions } from '../lib/files';
import { inlineWorkflow, sessionsOnMachine } from '../lib/machines';
import { useIsPhone, useReveal } from '../lib/layout';
import { MOD, newSessionHotkey } from '../lib/platform';
import { ConfirmModal } from './ConfirmModal';
import { WorkflowRunModal } from './workflow/WorkflowRunModal';
import { useIdentityResolver } from '../lib/identity';
import type { SidebarMode, SidebarSearchScope } from '../store';
import { projectAt, sessionsInProject, useStore } from '../store';
import { send } from '../ws';
import { FileSearchResults, FlagToggle } from './FileSearchPanel';
import { FileTree } from './FileTree';
import { SearchPlaceholder, SessionSearchResults } from './SessionSearchResults';

/**
 * Archived rows rendered before the "show more" step. Uncapped, a project with a
 * few hundred finished sessions paid for every one of them on the first paint and
 * on every re-render — and `showArchived` defaults to on.
 */
const ARCHIVED_PAGE = 20;

/** Sidebar sort menu, in menu order. `status` is the default — see `compareSessions`. */
const SORT_OPTIONS: { value: SessionSort; label: string }[] = [
  { value: 'status', label: 'Status' },
  { value: 'activity', label: 'Last active' },
  { value: 'created', label: 'Created' },
];

/**
 * Is a Mantine overlay that owns Esc on screen right now? Matched by Mantine's
 * own classes, and only when actually rendered: a bare `[role="dialog"]` query
 * also matched elements that are always mounted but hidden (and third-party
 * widgets), so the global Esc never fired at all.
 */
function overlayOpen(): boolean {
  const open = document.querySelectorAll(
    '.mantine-Modal-content, .mantine-Drawer-content, .mantine-Menu-dropdown, ' +
      '.mantine-Popover-dropdown, .mantine-Combobox-dropdown, .mantine-HoverCard-dropdown',
  );
  return [...open].some((el) => el.getClientRects().length > 0);
}

/** Find-in-sessions re-queries this long after the last keystroke. */
const SESSION_SEARCH_DEBOUNCE_MS = 250;

/** One formatter for the whole list: `toLocaleDateString` builds a new one per call. */
const rowDate = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function stop(e: { preventDefault: () => void; stopPropagation: () => void }) {
  e.preventDefault(); // don't follow the row link
  e.stopPropagation();
}

// Tooltip only useful when the name is actually clipped; measure on hover.
function useOverflow() {
  const [overflowing, setOverflowing] = useState(false);
  const check = useCallback((el: HTMLElement | null) => {
    if (el) setOverflowing(el.scrollWidth > el.clientWidth);
  }, []);
  return { overflowing, check };
}

/**
 * One sidebar row. Memoized because this list is long — a project with a few
 * hundred sessions renders a few hundred of these, each carrying ~4 Mantine
 * Tooltips — and it re-rendered in full on every selection change and on every
 * `sessions` map update, i.e. continuously through a live turn. `session` objects
 * keep their identity unless that session actually changed, so the memo holds.
 */
const SessionRow = memo(function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: SessionMeta;
  selected: boolean;
  /** Phone only: the sidebar is a drawer there, and it covers what was picked. */
  onSelect?: () => void;
}) {
  const status = sessionRowMeta(session);
  // Settled total plus the in-flight turn's live estimate, while one runs.
  const liveSpend = useStore((s) => s.turnSpend[session.id]);
  const cost = withLiveSpend(session.totalCostUsd, liveSpend, hasEstimatedSpend(session.costByModel));
  // Archive/complete and delete need Full access on a shared machine: a guest
  // without them never gets the controls, rather than ones that answer with an error.
  const canManage = useCanOnSession(session.id, 'manageSessions');
  const canDelete = useCanOnSession(session.id, 'deleteSessions');
  const identify = useIdentityResolver();
  // Whose machine this session runs on. A left accent in a colour reserved for
  // "somebody else's machine", plus their avatar — so a shared session is never
  // mistaken for a local one sitting next to it in the same project tab.
  const remote = useSessionMachine(session.id);
  const host = remote.isRemote ? identify(remote.ownerProfile?.userId, remote.ownerProfile) : null;
  // Whose turn is running, when it is not yours. One field on the synced meta, so
  // this survives a reload and a bridge restart.
  const turnActor = session.turnActor
    ? identify(session.turnActor.userId, session.turnActor)
    : null;
  const { overflowing, check } = useOverflow();
  const [hovered, setHovered] = useState(false);
  // Touch has no hover, so the row's actions would never appear on a phone.
  const show = useReveal(hovered);
  // A delete that has been sent but not echoed back. No optimistic removal: the
  // `sessionDeleted` echo stays the only thing that takes a row off the list, so a
  // delete that never lands leaves the row visible rather than silently "working".
  const [deleting, setDeleting] = useState(false);
  const setActionError = useStore((s) => s.setActionError);
  // A worktree session runs in a checkout of its own on its own branch, which the
  // row otherwise gives no sign of — the cwd isn't shown here.
  const projects = useStore((s) => s.projects);
  const worktree = findWorktree(projects, session.cwd)?.worktree;
  const deleteSession = (opts: { confirmFirst: boolean }) => {
    if (opts.confirmFirst) {
      // The app's own modal, not the native `confirm()`: a blocking dialog is
      // hostile on a phone, and this one already exists for every other
      // destructive action.
      setConfirmingDelete(true);
      return;
    }
    setActionError(null);
    if (send({ type: 'deleteSession', sessionId: session.id })) setDeleting(true);
  };
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // A session with no real prompt yet is safe to delete outright; others archive first.
  const isNew = session.nameAuto === true;
  const isPhone = useIsPhone();
  // Ran its workflow to the end but not manually completed — and never allowed to
  // mask a session that still needs the user.
  const finished = !session.completed && !status.actionable && isWorkflowFinished(session);
  const wide = session.completed || session.archived || finished;

  return (
    <UnstyledButton
      component={Link}
      to={`/session/${session.id}`}
      onClick={() => onSelect?.()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      px="sm"
      py={6}
      style={{
        display: 'block',
        borderRadius: 8,
        textDecoration: 'none',
        color: 'inherit',
        background: selected ? 'var(--mantine-color-default-hover)' : undefined,
        ...(host
          ? {
              borderLeft: '2px solid var(--mantine-color-grape-5)',
              paddingInlineStart: 'calc(var(--mantine-spacing-sm) - 2px)',
            }
          : {}),
      }}
    >
      <Group gap="xs" wrap="nowrap" justify="space-between">
        <Box style={{ minWidth: 0 }}>
          <Group gap={5} wrap="nowrap">
            {/* Whose turn is running, when it is not yours. One field on the
                synced meta, so this survives a reload and a bridge restart. */}
            {host && (
              <Tooltip label={`Runs on ${host.name}’s machine`} openDelay={300} withArrow>
                <Avatar
                  src={host.imageUrl ?? undefined}
                  size={14}
                  radius="xl"
                  color={host.color}
                  variant="filled"
                  style={{ flexShrink: 0 }}
                >
                  <Text size="8px" fw={700}>
                    {host.initials}
                  </Text>
                </Avatar>
              </Tooltip>
            )}
            {turnActor && !turnActor.self && (
              <Tooltip label={`${turnActor.name} is running this turn`} openDelay={300} withArrow>
                <Avatar
                  src={turnActor.imageUrl ?? undefined}
                  size={14}
                  radius="xl"
                  color={turnActor.color}
                  variant="filled"
                  style={{ flexShrink: 0 }}
                >
                  <Text size="8px" fw={700}>
                    {turnActor.initials}
                  </Text>
                </Avatar>
              </Tooltip>
            )}
            <Center w={wide ? 14 : 10} style={{ flex: wide ? '0 0 14px' : '0 0 10px' }}>
              {session.completed || session.archived ? (
                <IconCircleCheck size={14} color="var(--mantine-color-green-6)" style={{ flexShrink: 0 }} />
              ) : session.status === 'running' ? (
                <Loader size={10} />
              ) : finished ? (
                // Filled check: same "done" green as the manual-completed outline
                // check, inverted fill so the two read apart.
                <IconCircleCheckFilled
                  size={14}
                  color="var(--mantine-color-green-6)"
                  style={{ flexShrink: 0 }}
                />
              ) : (
                // `running` renders a Loader above, so only non-running
                // statuses reach here — `actionable` is the whole pulse rule.
                <span
                  className="status-dot"
                  data-pulse={status.actionable ? true : undefined}
                  style={
                    {
                      '--status-dot-color': `var(--mantine-color-${status.color}-6)`,
                      '--status-pulse-color': `var(--mantine-color-${status.color}-5)`,
                    } as CSSProperties
                  }
                />
              )}
            </Center>
            {worktree && (
              // Left of the name, in its own fixed slot so the names of worktree and
              // non-worktree rows still line up. Center handles both axes.
              <Tooltip label={`Worktree — ${worktree.branch ?? 'detached'}`} openDelay={400} withArrow>
                <Center w={13} h={13} c="dimmed" style={{ flex: '0 0 13px' }}>
                  <IconGitBranch size={12} />
                </Center>
              </Tooltip>
            )}
            <Tooltip
              label={session.name}
              disabled={!overflowing}
              openDelay={400}
              withArrow
              multiline
              maw={280}
            >
              <Text
                size="sm"
                fw={500}
                truncate
                ref={check}
                onMouseEnter={(e) => check(e.currentTarget)}
              >
                {session.name}
              </Text>
            </Tooltip>
          </Group>
          <Group gap={6} wrap="nowrap" align="center" mih={17} mt={3}>
            {isPhone || (!show && status.actionable) ? (
              <Badge
                variant="light" color={status.color} px={4}
                h={isPhone ? 20 : 12} style={{ fontSize: isPhone ? 12 : 8 }}
              >
                {status.label}
              </Badge>
            ) : (
              <>
                <Text size="xs" c="dimmed">
                  {rowDate.format(session.createdAt)}
                </Text>
                {cost.usd != null && (
                  <Text size="xs" c="dimmed">
                    {/* Derived from the session's own rows rather than its current
                        model: a provider-crossing workflow keeps one session, so
                        the model it is on now need not be the one it spent on. */}
                    {formatSpendUsd(cost.usd, cost.estimated)}
                  </Text>
                )}
                {session.totalTokens != null && (
                  <Tooltip
                    label={`${session.totalTokens.toLocaleString()} tokens spent`}
                    withArrow
                    fz="xs"
                  >
                    <Center c="dimmed">
                      <IconCoins size={11} />
                    </Center>
                  </Tooltip>
                )}
                {session.totalDurationMs != null && (
                  <Text size="xs" c="dimmed">
                    {formatDuration(session.totalDurationMs)}
                  </Text>
                )}
              </>
            )}
          </Group>
        </Box>
        <Group gap={2} wrap="nowrap">
          {!canManage && !canDelete ? null : isPhone ? (
            <Menu withinPortal position="bottom-end">
              <Menu.Target>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={`Actions for ${session.name}`}
                  onClick={stop}
                >
                  <IconDots size={18} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown onClick={stop}>
                {session.archived ? (
                  <>
                    {canManage && (
                      <Menu.Item
                        leftSection={<IconArchiveOff size={16} />}
                        onClick={() =>
                          send({
                            type: 'unarchiveSession',
                            sessionId: session.id,
                          })
                        }
                      >
                        Unarchive session
                      </Menu.Item>
                    )}
                    {canDelete && (
                      <Menu.Item
                        color="red"
                        disabled={deleting}
                        leftSection={<IconTrash size={16} />}
                        onClick={() => deleteSession({ confirmFirst: true })}
                      >
                        Delete session
                      </Menu.Item>
                    )}
                  </>
                ) : isNew ? (
                  canDelete && (
                    <Menu.Item
                      color="red"
                      disabled={deleting}
                      leftSection={<IconTrash size={16} />}
                      onClick={() => deleteSession({ confirmFirst: false })}
                    >
                      Delete session
                    </Menu.Item>
                  )
                ) : (
                  canManage && (
                    <>
                      <Menu.Item
                        leftSection={<IconCircleCheck size={16} />}
                        onClick={() => send({ type: 'completeSession', sessionId: session.id })}
                      >
                        Mark completed
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<IconArchive size={16} />}
                        onClick={() => send({ type: 'archiveSession', sessionId: session.id })}
                      >
                        Archive session
                      </Menu.Item>
                    </>
                  )
                )}
              </Menu.Dropdown>
            </Menu>
          ) : session.archived ? (
            <>
              {canManage && (
                <Tooltip label="Unarchive session">
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="gray"
                    onClick={(e) => {
                      stop(e);
                      send({ type: 'unarchiveSession', sessionId: session.id });
                    }}
                  >
                    <IconArchiveOff size={13} />
                  </ActionIcon>
                </Tooltip>
              )}
              {canDelete && (
                <Tooltip label={deleting ? 'Deleting…' : 'Delete session'}>
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="gray"
                    loading={deleting}
                    onClick={(e) => {
                      stop(e);
                      deleteSession({ confirmFirst: true });
                    }}
                  >
                    <IconTrash size={13} />
                  </ActionIcon>
                </Tooltip>
              )}
            </>
          ) : isNew ? (
            canDelete && (
              <Tooltip label={deleting ? 'Deleting…' : 'Delete session'}>
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="gray"
                  loading={deleting}
                  onClick={(e) => {
                    // No confirm: a session with no real prompt yet has nothing to lose.
                    stop(e);
                    deleteSession({ confirmFirst: false });
                  }}
                >
                  <IconTrash size={13} />
                </ActionIcon>
              </Tooltip>
            )
          ) : (
            canManage && (
              <>
                <Tooltip label="Mark completed">
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="gray"
                    onClick={(e) => {
                      stop(e);
                      send({ type: 'completeSession', sessionId: session.id });
                    }}
                  >
                    <IconCircleCheck size={13} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Archive session">
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="gray"
                    onClick={(e) => {
                      stop(e);
                      send({ type: 'archiveSession', sessionId: session.id });
                    }}
                  >
                    <IconArchive size={13} />
                  </ActionIcon>
                </Tooltip>
              </>
            )
          )}
        </Group>
      </Group>
      <ConfirmModal
        opened={confirmingDelete}
        title="Delete session"
        message={`Delete session “${session.name}”? Its transcript goes with it.`}
        confirmLabel="Delete"
        confirmColor="red"
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => {
          setConfirmingDelete(false);
          deleteSession({ confirmFirst: false });
        }}
      />
    </UnstyledButton>
  );
});

/**
 * Directories that hold sessions but have no project key — checkouts that live
 * only on another machine, so this bridge could never resolve them. Offering an
 * explicit bind is the one case automatic identification can't cover.
 */
function UnlinkedCheckouts({ activeKey }: { activeKey: string }) {
  const sessions = useStore((s) => s.sessions);
  const projectKeys = useStore((s) => s.projectKeys);
  const activeProject = useStore((s) => s.activeProject);
  const projects = useStore((s) => s.projects);

  const dismissedCheckouts = useStore((s) => s.dismissedCheckouts);
  const setCheckoutDismissed = useStore((s) => s.setCheckoutDismissed);

  const { unlinked, dismissed } = useMemo(() => {
    const known = new Set(projects.flatMap(projectPaths));
    const counts = new Map<string, number>();
    for (const s of Object.values(sessions)) {
      if (!s.cwd || s.cwd === activeProject || projectKeys[s.cwd]) continue;
      // A directory this machine already attributes to a project is not a foreign
      // checkout, keyed or not — a work tree of a remote-less repo has no key to
      // resolve and used to be nagged about here.
      if (known.has(s.cwd)) continue;
      counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
    }
    const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const hidden = new Set(dismissedCheckouts);
    return {
      unlinked: byCount.filter(([cwd]) => !hidden.has(cwd)),
      dismissed: byCount.filter(([cwd]) => hidden.has(cwd)),
    };
  }, [sessions, projectKeys, activeProject, projects, dismissedCheckouts]);

  const total = unlinked.reduce((n, [, count]) => n + count, 0);
  // Dismissing every candidate removes the hint entirely — the point of marking
  // them is that there's nothing left to decide.
  if (unlinked.length === 0) return null;

  // Collapsed to a single dimmed line: this is an occasional one-time fixup,
  // not something worth standing between the user and their session list.
  return (
    <Popover width="min(320px, calc(100vw - 2rem))" position="top" withArrow shadow="md">
      <Popover.Target>
        <UnstyledButton px="sm" py={6} mt={4} style={{ opacity: 0.55 }}>
          <Group gap={5} wrap="nowrap">
            <IconLink size={12} />
            <Text size="xs" c="dimmed">
              {total} session{total === 1 ? '' : 's'} in another checkout
            </Text>
          </Group>
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={8}>
          <Text size="xs" c="dimmed">
            These ran in a directory this machine doesn't have — most likely the same repo on
            another computer. Link one to fold its sessions into this project.
          </Text>
          {unlinked.map(([cwd, count]) => (
            <Group key={cwd} gap={6} wrap="nowrap">
              <Text size="xs" ff="monospace" truncate style={{ flex: 1 }} title={cwd}>
                {cwd}
              </Text>
              <Badge size="xs" variant="default">
                {count}
              </Badge>
              <Tooltip label="Link to this project">
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  onClick={() => send({ type: 'linkProjectPath', path: cwd, key: activeKey })}
                >
                  <IconLink size={13} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Not one of my projects — hide it">
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  onClick={() => setCheckoutDismissed(cwd, true)}
                >
                  <IconEyeOff size={13} />
                </ActionIcon>
              </Tooltip>
            </Group>
          ))}
          {dismissed.length > 0 && (
            <>
              <Divider />
              <Text size="xs" c="dimmed">
                Hidden
              </Text>
              {dismissed.map(([cwd, count]) => (
                <Group key={cwd} gap={6} wrap="nowrap" opacity={0.6}>
                  <Text size="xs" ff="monospace" truncate style={{ flex: 1 }} title={cwd}>
                    {cwd}
                  </Text>
                  <Badge size="xs" variant="default">
                    {count}
                  </Badge>
                  <Tooltip label="Show again">
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="gray"
                      onClick={() => setCheckoutDismissed(cwd, false)}
                    >
                      <IconEye size={13} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              ))}
            </>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

export function Sidebar({
  onEditWorkflows,
  onBrowseRecipes,
  onNavigate,
}: {
  onEditWorkflows: () => void;
  onBrowseRecipes: () => void;
  /** Called when the user picks something. Supplied only on a phone, where this
   *  list is a drawer sitting on top of the thing they just picked. */
  onNavigate?: () => void;
}) {
  const sessions = useStore((s) => s.sessions);
  const sessionMachine = useStore((s) => s.sessionMachine);
  const primaryDeviceId = useStore((s) => s.primaryDeviceId);
  const workflows = useStore((s) => s.workflows);
  const sharedWorkflows = useStore((s) => s.sharedWorkflows);
  const selectedSessionId = useStore((s) => s.selectedSessionId);
  const canCreate = useCan('createSessions');
  const activeProject = useStore((s) => s.activeProject);
  const access = useStore((s) => s.access);
  const [showArchived, setShowArchived] = useLocalStorage<boolean>({
    key: 'lines.showArchived',
    defaultValue: true,
  });
  const [archivedShown, setArchivedShown] = useState(ARCHIVED_PAGE);
  // '' = raw session, otherwise workflow id.
  const [lastChoice, setLastChoice] = useLocalStorage<string>({
    key: 'lines.lastNewSessionChoice',
    defaultValue: '',
  });
  /**
   * On a shared machine `workflows` is the host's library, and the user's own
   * comes from their own machine's slice (when one is loaded). A workflow picked
   * from it runs on the host as an inline snapshot (see `createSession`).
   */
  const hostProfile = useStore((s) => (s.access ? s.machines[s.primaryDeviceId ?? '']?.ownerProfile : null));
  const ownView = useStore((s) =>
    s.access ? Object.values(s.machines).find((m) => !m.view.access)?.view : undefined,
  );
  const hostName = access ? (hostProfile?.name ?? hostProfile?.email ?? 'Host') : null;
  const ownWorkflows = useMemo(
    () =>
      (ownView?.workflows ?? []).filter(
        (o) => !workflows.some((w) => w.id === o.id) && !sharedWorkflows.some((w) => w.id === o.id),
      ),
    [ownView, workflows, sharedWorkflows],
  );
  const lastWorkflow = [...workflows, ...sharedWorkflows, ...ownWorkflows].find((w) => w.id === lastChoice);
  // An id present in both lists is owned — it must not also appear under
  // "Shared by others", where picking it would read as running someone else's.
  // On a shared machine "owned" covers the user's own library too.
  const foreignWorkflows = sharedWorkflows.filter(
    (s) => !workflows.some((w) => w.id === s.id) && !(ownView?.workflows ?? []).some((w) => w.id === s.id),
  );
  /**
   * One of the user's own workflows made self-contained for the host, or why it
   * cannot be — null when it is not one of theirs. Refused when their own machine
   * holds any of it back: the host has no way to tell, so it must not travel.
   */
  const ownInline = (workflowId: string): ReturnType<typeof inlineWorkflow> | null => {
    const own = ownWorkflows.find((w) => w.id === workflowId);
    return own && ownView ? inlineWorkflow(own, ownView.steps, ownView.pinnedSteps, ownView.sharedSteps) : null;
  };
  // Persisted like `lastChoice`: running every new session in its own checkout is a
  // working habit, not a per-click decision.
  const [worktreeMode, setWorktreeMode] = useLocalStorage<boolean>({
    key: 'lines.newSessionWorktree',
    defaultValue: false,
  });
  // Persisted like the toggles above. Defaults to urgency order: the session that
  // needs the user must not sit below newer idle ones in a busy project.
  const [sessionSort, setSessionSort] = useLocalStorage<SessionSort>({
    key: SESSION_SORT_KEY,
    defaultValue: 'status',
  });
  const compare = useMemo(() => compareSessions(sessionSort), [sessionSort]);

  // A project switch starts the archived list over: the point of the cap is that
  // the first paint of a tab is cheap.
  useEffect(() => {
    setArchivedShown(ARCHIVED_PAGE);
  }, [activeProject]);

  const projectKeys = useStore((s) => s.projectKeys);
  const projects = useStore((s) => s.projects);
  const project = projectAt(projects, activeProject);
  const roots = project ? projectRoots(project) : [];
  const activeProjectKey = activeProject ? (projectKeys[activeProject] ?? null) : null;
  /**
   * One machine's sessions, not every linked machine's.
   *
   * The store deliberately holds them all — that is how a message reaches the
   * machine that hosts its session, and how a shared machine still raises a
   * notification — but a list that mixes two computers together cannot say which
   * one a row runs on, and the projects around it describe only this one. The
   * switcher in the header is how the other machine's list is reached.
   */
  const machineSessions = useMemo(
    () => sessionsOnMachine(sessions, sessionMachine, primaryDeviceId ?? ''),
    [sessions, sessionMachine, primaryDeviceId],
  );
  const projectSessions = sessionsInProject(machineSessions, projectKeys, project);
  /**
   * Sessions shared with this user that no project tab covers.
   *
   * A guest's tabs are built from the shared sessions in that machine's `hello`
   * (`guestProjects`), so this catches what arrived after it — a session shared
   * later, in a folder no tab covers — which would otherwise be held in the
   * store and rendered nowhere. Every tab counts, not only the active one:
   * otherwise each other project's sessions would land here too.
   */
  const covered = useMemo(
    () =>
      access
        ? new Set(
            projects.flatMap((p) =>
              sessionsInProject(machineSessions, projectKeys, p).map((s) => s.id),
            ),
          )
        : new Set<string>(),
    [access, projects, machineSessions, projectKeys],
  );
  const shared = access
    ? Object.values(machineSessions)
        .filter((s) => !s.archived && !covered.has(s.id))
        .sort(compare)
    : [];
  const list = projectSessions.filter((s) => !s.archived).sort(compare);
  // Same comparator as the live list rather than an `archivedAt` key of its own:
  // archiving is an upsert, so `status` and `activity` still put the most recently
  // archived first, and `created` means creation order — which is what it says.
  const archived = projectSessions.filter((s) => s.archived).sort(compare);

  // Model/mode come from the settings modal (header gear); compression still
  // inherits from the project's latest session.
  const newSessionDefaults = useStore((s) => s.newSessionDefaults);
  const markSessionCreatePending = useStore((s) => s.markSessionCreatePending);
  const actionError = useStore((s) => s.actionError);
  const setSidebarActionError = useStore((s) => s.setActionError);
  const worktreePending = useStore((s) => s.worktreePending);
  const setWorktreePending = useStore((s) => s.setWorktreePending);
  const pendingCreate = useStore((s) => s.pendingCreate);
  const focusComposerFor = useStore((s) => s.focusComposerFor);
  const isPhone = useIsPhone();
  // iOS raises the keyboard only for a focus() made inside the tap itself, and the
  // new session's composer mounts a round-trip later. Focusing this offscreen field
  // in the tap brings the keyboard up; the composer then takes focus from it and
  // the keyboard stays.
  const keyboardPrimer = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const primer = keyboardPrimer.current;
    if (!primer || document.activeElement !== primer) return;
    // Still waiting: the create is in flight, or it landed and its composer is
    // about to take focus.
    if (!actionError && (pendingCreate || worktreePending || focusComposerFor)) return;
    // The create failed or its intent expired — nothing will take the focus over.
    primer.blur();
  }, [pendingCreate, worktreePending, focusComposerFor, actionError]);
  const createSession = (workflowId?: string, stepOverrides?: (WorkflowStepOverride | null)[]) => {
    if (!activeProject) return;
    // The user's own workflow, on a machine whose library does not have it: it
    // travels inline, every step resolved here, since the host cannot.
    const isOwn = !!workflowId && ownWorkflows.some((w) => w.id === workflowId);
    const inlined = isOwn ? ownInline(workflowId!) : null;
    if (isOwn && !inlined?.ok) {
      setSidebarActionError(
        inlined?.reason === 'unverified'
          ? 'Your machine has not verified everything this workflow runs. Review it there in Workflows first.'
          : 'One of this workflow’s shared steps is not available here.',
      );
      return;
    }
    const workflowDef = inlined?.ok ? inlined.def : null;
    if (isPhone) {
      // A stale error would blur the primer on the spot.
      setSidebarActionError(null);
      keyboardPrimer.current?.focus();
    }
    // Records the intent that lets the resulting upsert take the selection; the
    // reducer no longer guesses from `createdAt` (a timestamp from another machine).
    markSessionCreatePending();
    // `worktree add` is a multi-second git operation the server awaits before the
    // session exists, so the button has to stay busy — a second click would cut a
    // second work tree.
    if (worktreeMode) {
      setSidebarActionError(null);
      setWorktreePending(true);
    }
    send({
      type: 'createSession',
      name: 'New session',
      cwd: activeProject,
      model: newSessionDefaults.model,
      permissionMode: newSessionDefaults.permissionMode,
      reasoningEffort: newSessionDefaults.reasoningEffort,
      workflowId,
      ...(workflowDef ? { workflowDef } : {}),
      ...(workflowId && stepOverrides?.some(Boolean) ? { stepOverrides } : {}),
      // Empty object = let the server name the branch and the path.
      ...(worktreeMode ? { worktree: {} } : {}),
    });
    setLastChoice(workflowId ?? '');
    // On a phone the drawer sits over the composer the user is about to type in.
    onNavigate?.();
  };

  /** The workflow whose per-step models are being chosen before a launch. */
  const [tuneWorkflow, setTuneWorkflow] = useState<WorkflowDef | null>(null);
  /**
   * A new-session click with a workflow. Cmd/Ctrl+click opens the per-run
   * model/effort picker instead of launching; a plain click launches as before.
   */
  const createFromClick = (e: ReactMouseEvent, workflowId?: string) => {
    // An own workflow on a shared machine is tuned in its inlined form: its refs
    // do not resolve against the host's step library.
    const inlined = workflowId && ownWorkflows.some((w) => w.id === workflowId) ? ownInline(workflowId) : null;
    const wf = workflowId
      ? ((inlined?.ok ? inlined.def : null) ?? [...workflows, ...sharedWorkflows].find((w) => w.id === workflowId))
      : undefined;
    if (wf && (e.metaKey || e.ctrlKey)) {
      setTuneWorkflow(wf);
      return;
    }
    createSession(workflowId);
  };
  // Mirrors the primary button: a new session with the last choice. Not on a
  // phone (no keyboard to speak of), and not while a modal or menu owns the keys.
  const hotkey = newSessionHotkey();
  const canHotkeyCreate = !isPhone && canCreate && !!activeProject && !worktreePending;
  useHotkeys(
    [
      [
        hotkey.key,
        () => {
          if (!canHotkeyCreate || overlayOpen()) return;
          createSession(lastWorkflow?.id);
        },
        { preventDefault: canHotkeyCreate },
      ],
    ],
    [], // like Cmd+F below: it has to work from the composer textarea too
    true,
  );
  const modHint = `${MOD}-click to choose models per step`;

  // The dropdown spans the whole split button rather than a fixed 240px. Measured
  // rather than hard-coded: the sidebar is drag-resizable, and `width="target"`
  // would match the chevron half alone.
  const [createRow, setCreateRow] = useState<HTMLDivElement | null>(null);
  const [menuWidth, setMenuWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!createRow) return;
    const observer = new ResizeObserver(([entry]) => setMenuWidth(entry.contentRect.width));
    observer.observe(createRow);
    return () => observer.disconnect();
  }, [createRow]);

  const sidebarMode = useStore((s) => s.sidebarMode);
  const setSidebarMode = useStore((s) => s.setSidebarMode);
  const openFileTab = useStore((s) => s.openFileTab);
  // The same flag the Cmd+P palette reads, so one toggle governs both views.
  const hideIgnored = useStore((s) => s.hideIgnored);
  const setHideIgnored = useStore((s) => s.setHideIgnored);
  const activeFile = useStore((s) =>
    activeProject ? (s.openFiles[activeProject]?.active ?? null) : null,
  );

  // The sidebar search, open over the session list. Its input takes the New
  // session row's place, and the scope toggle under it picks what is searched.
  const sidebarSearch = useStore((s) => s.sidebarSearch);
  const setSidebarSearch = useStore((s) => s.setSidebarSearch);
  const openSidebarSearch = useStore((s) => s.openSidebarSearch);
  const searchFocus = useStore((s) => s.searchFocus);
  const fileSearch = useStore((s) => s.fileSearch);
  const setFileSearch = useStore((s) => s.setFileSearch);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchQuery = sidebarSearch?.query ?? '';
  const searchScope = sidebarSearch?.scope ?? 'all';
  const searching = sidebarMode === 'sessions' && !!sidebarSearch;

  useEffect(() => {
    if (!searchFocus) return;
    // After the commit that mounts the input, when the search was just opened.
    requestAnimationFrame(() => {
      searchInput.current?.focus();
      searchInput.current?.select();
    });
  }, [searchFocus]);

  // Cmd/Ctrl+F opens the search on a session scope — the one it last had, All
  // sessions for a fresh search or when coming from Files; Cmd/Ctrl+Shift+F
  // opens it on Files. Cmd+F deliberately takes
  // over the browser's find-in-page — the transcript is windowed, so that only
  // ever searched the rows that happened to be mounted. Same rule as Cmd+P: with
  // no project (a guest, the folder picker) both keys are left to the browser,
  // and on a phone the search icon is the way in. A Monaco editor keeps its own
  // Cmd+F: it handles and stops the key before it reaches the document.
  const canSearch = !isPhone && roots.length > 0;
  useHotkeys(
    [
      [
        'mod+F',
        // From the Files scope, Cmd+F means "sessions" — the pair reads as
        // Cmd+F sessions / Cmd+Shift+F files, as the placeholder says.
        () =>
          canSearch &&
          openSidebarSearch(useStore.getState().sidebarSearch?.scope === 'files' ? 'all' : undefined),
        { preventDefault: canSearch },
      ],
      ['mod+shift+F', () => canSearch && openSidebarSearch('files'), { preventDefault: canSearch }],
    ],
    [], // no tag is ignored — the shortcut has to work from the composer textarea too
    true,
  );

  // Session scopes search the ids this sidebar lists for the project (or just
  // the selected one), so a hit is always a session the user can see here. The
  // Files scope runs its own request in FileSearchResults.
  const searchRootsKey = activeProject ? rootsForCwd(projects, activeProject).join('\n') : '';
  const searchIdsKey = !searching || searchScope === 'files'
    ? ''
    : searchScope === 'session'
      ? (selectedSessionId ?? '')
      : [...shared, ...list, ...archived].map((s) => s.id).join('\n');
  // Results are shown only for the request they answered. Until a new reply
  // lands they are hidden, not left up: after a keystroke, a scope flip or a
  // reopen they describe a different search.
  const sessionSearchKey = `${searchQuery}\0${searchIdsKey}`;
  const searchSeq = useRef(0);
  useEffect(() => {
    const seq = ++searchSeq.current;
    if (!searchQuery || !searchIdsKey) {
      if (sidebarSearch?.results || sidebarSearch?.loading) {
        setSidebarSearch({ results: null, resultsFor: '', loading: false, error: null });
      }
      return;
    }
    const timer = setTimeout(async () => {
      setSidebarSearch({ loading: true });
      try {
        const results = await searchSessions(
          searchRootsKey ? searchRootsKey.split('\n') : [],
          searchQuery,
          {},
          searchIdsKey.split('\n'),
        );
        if (seq !== searchSeq.current) return;
        setSidebarSearch({ results, resultsFor: sessionSearchKey, loading: false, error: null });
      } catch (err) {
        if (seq !== searchSeq.current) return;
        setSidebarSearch({
          results: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, SESSION_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // The session list churns through every live turn; only the ids matter, and
    // re-querying on each status change is deliberately not done.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchIdsKey, searchRootsKey]);
  // A project switch starts the search over: its hits describe the old tab.
  useEffect(() => {
    setSidebarSearch(null);
  }, [activeProject, setSidebarSearch]);
  // Esc anywhere closes the search, not only from its input. Bubble phase on
  // window, so every nearer Esc owner has had its turn first, and it steps
  // aside for them: a handled key (a mention menu, an inline edit), an open
  // overlay (a modal, menu or popover closes on Esc itself), or a Monaco editor
  // (Esc closes its find widget).
  useEffect(() => {
    if (!searching) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('.monaco-editor')) return;
      if (overlayOpen()) return;
      setSidebarSearch(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [searching, setSidebarSearch]);
  const toggleSearch = () => (sidebarSearch ? setSidebarSearch(null) : openSidebarSearch());
  const searchLoading = searchScope === 'files' ? fileSearch.loading : !!sidebarSearch?.loading;

  return (
    <Stack gap={0} h="100%">
      <Group px="sm" py="xs" justify="space-between">
        <Group gap={4}>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase">
            {sidebarMode === 'files' ? 'Files' : 'Sessions'}
          </Text>
          {/* Next to the label rather than with the Recipes/Workflows icons on the
              right: this one governs the list below it, the others open dialogs. */}
          {sidebarMode === 'sessions' && (
            <Menu position="bottom-start" width={180}>
              <Menu.Target>
                <Tooltip label="Sort sessions">
                  <ActionIcon variant="subtle" color="gray" size="sm">
                    <IconArrowsSort size={15} />
                  </ActionIcon>
                </Tooltip>
              </Menu.Target>
              <Menu.Dropdown>
                {SORT_OPTIONS.map((opt) => (
                  <Menu.Item
                    key={opt.value}
                    onClick={() => setSessionSort(opt.value)}
                    rightSection={
                      sessionSort === opt.value ? <IconCircleCheck size={14} /> : undefined
                    }
                  >
                    {opt.label}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          )}
          {sidebarMode === 'sessions' && (
            <Tooltip label={sidebarSearch ? 'Close search' : 'Search sessions and files'}>
              <ActionIcon
                variant={sidebarSearch ? 'light' : 'subtle'}
                color="gray"
                size="sm"
                aria-pressed={!!sidebarSearch}
                onClick={toggleSearch}
              >
                <IconSearch size={15} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
        {sidebarMode === 'files' && (
          <Switch
            size="xs"
            checked={hideIgnored}
            onChange={(e) => setHideIgnored(e.currentTarget.checked)}
            label={
              <Text size="xs" c="dimmed">
                Hide ignored
              </Text>
            }
          />
        )}
        {sidebarMode === 'sessions' && (
          <Group gap={2}>
            <Tooltip label="Recipes">
              <ActionIcon variant="subtle" color="gray" size="sm" onClick={onBrowseRecipes}>
                <IconBook size={15} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Workflows">
              <ActionIcon variant="subtle" color="gray" size="sm" onClick={onEditWorkflows}>
                <IconRoute size={15} />
              </ActionIcon>
            </Tooltip>
          </Group>
        )}
      </Group>
      {searching && sidebarSearch && (
        <Stack gap={4} px="sm" pb="xs">
          <TextInput
            ref={searchInput}
            size="xs"
            value={searchQuery}
            placeholder={searchScope === 'files' ? 'Search in files' : 'Search sessions'}
            leftSection={searchLoading ? <Loader size={10} /> : <IconSearch size={13} />}
            rightSectionWidth={searchScope === 'files' ? 126 : undefined}
            rightSection={
              <Group gap={2} wrap="nowrap">
                {searchScope === 'files' && (
                  <>
                    <FlagToggle
                      label="Aa"
                      tip="Match case"
                      on={fileSearch.caseSensitive}
                      onToggle={() => setFileSearch({ caseSensitive: !fileSearch.caseSensitive })}
                    />
                    <FlagToggle
                      label="ab"
                      tip="Match whole word"
                      on={fileSearch.wholeWord}
                      onToggle={() => setFileSearch({ wholeWord: !fileSearch.wholeWord })}
                    />
                    <FlagToggle
                      label=".*"
                      tip="Use regular expression"
                      on={fileSearch.regex}
                      onToggle={() => setFileSearch({ regex: !fileSearch.regex })}
                    />
                    {/* The same flag the file tree and Cmd+P read, as a toggle in
                        the row rather than a switch under it: a row of its own made
                        the results area — and its placeholder — jump on a scope flip. */}
                    <Tooltip label={hideIgnored ? 'Show ignored files' : 'Hide ignored files'} openDelay={300}>
                      <ActionIcon
                        size="sm"
                        variant={hideIgnored ? 'filled' : 'subtle'}
                        color="gray"
                        aria-pressed={hideIgnored}
                        aria-label="Hide ignored files"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setHideIgnored(!hideIgnored)}
                      >
                        <IconEyeOff size={13} />
                      </ActionIcon>
                    </Tooltip>
                  </>
                )}
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="gray"
                  aria-label="Close search"
                  onClick={() => setSidebarSearch(null)}
                >
                  <IconX size={12} />
                </ActionIcon>
              </Group>
            }
            onChange={(e) => setSidebarSearch({ query: e.currentTarget.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setSidebarSearch(null);
              }
            }}
          />
          <SegmentedControl
            size="xs"
            fullWidth
            value={searchScope}
            onChange={(v) => {
              setSidebarSearch({ scope: v as SidebarSearchScope });
              searchInput.current?.focus();
            }}
            data={[
              { value: 'all', label: 'All sessions' },
              { value: 'session', label: 'This session', disabled: !selectedSessionId },
              { value: 'files', label: 'Files', disabled: roots.length === 0 },
            ]}
          />
          {searchScope !== 'files' && sidebarSearch.error && (
            <Text size="xs" c="red">
              {sidebarSearch.error}
            </Text>
          )}
        </Stack>
      )}
      {/* A guest creates sessions only with an explicit machine-scope grant: a
          session share has no folder to create in, and the bridge refuses it. */}
      {sidebarMode === 'sessions' && !searching && canCreate && (
        <Box px="sm" pb="xs" ref={setCreateRow}>
          {/* The keyboard primer. 16px so iOS does not zoom in on focus; pinned
              in view so focusing it does not scroll anything. */}
          {isPhone && (
            <input
              ref={keyboardPrimer}
              aria-hidden
              tabIndex={-1}
              style={{
                position: 'fixed',
                top: 0,
                left: 0,
                width: 1,
                height: 1,
                padding: 0,
                border: 0,
                opacity: 0,
                fontSize: 16,
                pointerEvents: 'none',
              }}
            />
          )}
          <Button.Group style={{ width: '100%' }}>
            <Tooltip
              label={`New session (${hotkey.label})${lastWorkflow ? ` · ${modHint}` : ''}`}
              withArrow
              fz="xs"
              openDelay={500}
              disabled={isPhone}
            >
              <Button
                style={{ flex: 1 }}
                // currentColor: the button is disabled while this shows, so the
                // loader follows the disabled text colour in either scheme.
                leftSection={worktreePending ? <Loader size={12} color="currentColor" /> : <IconPlus size={14} />}
                onClick={(e) => createFromClick(e, lastWorkflow?.id)}
                disabled={!activeProject || worktreePending}
              >
                {lastWorkflow ? lastWorkflow.name : 'New session'}
                {worktreeMode ? ' in worktree' : ''}
              </Button>
            </Tooltip>
            {/* Always rendered now: the worktree toggle lives here, so the split
                half can no longer depend on a workflow existing. */}
            <Menu position="bottom-end" width={menuWidth ?? 240}>
              <Menu.Target>
                {/* A hairline in the button's own text colour, so the split reads
                    as two halves on a flat monochrome fill. */}
                <Button
                  px={6}
                  disabled={!activeProject}
                  style={{
                    borderInlineStartWidth: 1,
                    borderInlineStartColor: 'color-mix(in srgb, currentColor 25%, transparent)',
                  }}
                >
                  <IconChevronDown size={14} />
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {/* A plain Box, not a Menu.Item: that renders its own <button>, and a
                    Switch inside one is invalid markup whose click lands on either
                    control depending on the pixel. Outside a Menu.Item it also keeps
                    the dropdown open, so the toggle can be flipped and then used. */}
                <Box px="sm" py={6}>
                  <Switch
                    size="xs"
                    // Text left, control hard right, both vertically centred against
                    // the two-line label — the row reads like a settings line rather
                    // than a menu entry, which is what it is.
                    labelPosition="left"
                    label="Run in a new worktree"
                    description="Work is committed to a separate branch"
                    checked={worktreeMode}
                    onChange={(e) => setWorktreeMode(e.currentTarget.checked)}
                    styles={{
                      body: {
                        width: '100%',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      },
                      labelWrapper: {
                        marginInlineEnd: 'var(--mantine-spacing-sm)',
                      },
                    }}
                  />
                </Box>
                <Menu.Divider />
                <Menu.Item onClick={() => createSession()}>New session</Menu.Item>
                {workflows.length > 0 && (
                  <>
                    <Menu.Divider />
                    <Menu.Label>
                      <Group justify="space-between" wrap="nowrap" gap="xs">
                        <span>With workflow</span>
                        {!isPhone && (
                          <Text fz={10} c="dimmed" truncate>
                            {modHint}
                          </Text>
                        )}
                      </Group>
                    </Menu.Label>
                    {workflows.map((w) => (
                      <Menu.Item
                        key={w.id}
                        onClick={(e) => createFromClick(e, w.id)}
                        // On a shared machine these are the host's, so say whose.
                        rightSection={
                          hostName && (
                            <Text size="xs" c="dimmed" truncate maw={90}>
                              {hostName}
                            </Text>
                          )
                        }
                      >
                        {w.name}
                      </Menu.Item>
                    ))}
                  </>
                )}
                {ownWorkflows.length > 0 && (
                  <>
                    <Menu.Divider />
                    <Menu.Label>
                      <Group justify="space-between" wrap="nowrap" gap="xs">
                        <span>Yours</span>
                        {!isPhone && workflows.length === 0 && (
                          <Text fz={10} c="dimmed" truncate>
                            {modHint}
                          </Text>
                        )}
                      </Group>
                    </Menu.Label>
                    {ownWorkflows.map((w) => (
                      <Menu.Item key={w.id} onClick={(e) => createFromClick(e, w.id)}>
                        {w.name}
                      </Menu.Item>
                    ))}
                  </>
                )}
                {foreignWorkflows.length > 0 && (
                  <>
                    <Menu.Divider />
                    <Menu.Label>
                      <Group justify="space-between" wrap="nowrap" gap="xs">
                        <span>Shared by others</span>
                        {/* The hint rides the first workflow header only. */}
                        {!isPhone && workflows.length === 0 && ownWorkflows.length === 0 && (
                          <Text fz={10} c="dimmed" truncate>
                            {modHint}
                          </Text>
                        )}
                      </Group>
                    </Menu.Label>
                    {foreignWorkflows.map((w) => (
                      <Menu.Item
                        key={w.id}
                        onClick={(e) => createFromClick(e, w.id)}
                        rightSection={
                          <Text size="xs" c="dimmed" truncate maw={90}>
                            {w.ownerName ?? 'Unknown'}
                          </Text>
                        }
                      >
                        {w.name}
                      </Menu.Item>
                    ))}
                  </>
                )}
              </Menu.Dropdown>
            </Menu>
          </Button.Group>
          {tuneWorkflow && (
            <WorkflowRunModal
              opened
              workflow={tuneWorkflow}
              confirmLabel="Start session"
              onConfirm={(overrides) => createSession(tuneWorkflow.id, overrides)}
              onClose={() => setTuneWorkflow(null)}
            />
          )}
        </Box>
      )}
      {actionError && (
        // The one place a dropped control message becomes visible. Click to dismiss;
        // it is a notice about a send that did not happen, not a persistent state.
        <Box px="sm" pb="xs">
          <Text size="xs" c="red" onClick={() => setSidebarActionError(null)} style={{ cursor: 'pointer' }}>
            {actionError}
          </Text>
        </Box>
      )}
      {searching && !searchQuery ? (
        // Outside the ScrollArea: its content box is only as tall as what it
        // holds, so a placeholder inside could never centre in the free space.
        <Box style={{ flex: 1, minHeight: 0 }}>
          <SearchPlaceholder scope={searchScope} />
        </Box>
      ) : (
      <ScrollArea style={{ flex: 1 }} px={6}>
        {searching ? (
          searchScope === 'files' ? (
            <FileSearchResults query={searchQuery} onNavigate={onNavigate} />
          ) : sidebarSearch?.results && sidebarSearch.resultsFor === sessionSearchKey ? (
            <SessionSearchResults
              results={sidebarSearch.results}
              query={searchQuery}
              onNavigate={onNavigate}
            />
          ) : null
        ) : sidebarMode === 'files' ? (
          roots.length > 0 ? (
            <Box pb="sm">
              {roots.map((root) => (
                <Box key={root}>
                  {/* Only a multi-root project needs headers — a single tree is
                      already unambiguously the project's. */}
                  {roots.length > 1 && (
                    <Text size="10px" c="dimmed" fw={600} tt="uppercase" px={6} pt={6} truncate>
                      {root.split('/').filter(Boolean).pop() ?? root}
                    </Text>
                  )}
                  <FileTree root={root} onFileClick={openFileTab} selectedPath={activeFile} />
                </Box>
              ))}
            </Box>
          ) : (
            <Text size="xs" c="dimmed" ta="center" pt="lg">
              No active project
            </Text>
          )
        ) : (
          <Stack gap={2} pb="sm">
            {shared.length > 0 && (
              <>
                <Text size="xs" fw={600} c="dimmed" tt="uppercase" px="sm" pt={4} pb={2}>
                  Shared with me
                </Text>
                {shared.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    selected={s.id === selectedSessionId}
                    onSelect={onNavigate}
                  />
                ))}
              </>
            )}
            {list.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                selected={s.id === selectedSessionId}
                onSelect={onNavigate}
              />
            ))}
            {list.length === 0 && archived.length === 0 && shared.length === 0 && (
              <Text size="xs" c="dimmed" ta="center" pt="lg">
                {access ? 'Nothing has been shared with you yet' : 'No sessions in this project yet'}
              </Text>
            )}
            {archived.length > 0 && (
              <>
                {/* The active list above ends without a marker of its own, so the
                    rule is what says "everything below here is finished". */}
                <Divider mt="xs" mx="sm" />
                <Group gap={4} justify="space-between" wrap="nowrap" px="sm" pt={4}>
                  <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                    Archived ({archived.length})
                  </Text>
                  <Tooltip label={showArchived ? 'Hide archived' : 'Show archived'}>
                    <ActionIcon
                      size="xs"
                      variant="subtle"
                      color="gray"
                      onClick={() => setShowArchived((v) => !v)}
                    >
                      <IconChevronDown
                        size={14}
                        style={{
                          transform: showArchived ? undefined : 'rotate(-90deg)',
                          transition: 'transform 120ms',
                        }}
                      />
                    </ActionIcon>
                  </Tooltip>
                </Group>
                {showArchived && (
                  <>
                    {archived.slice(0, archivedShown).map((s) => (
                      <SessionRow
                        key={s.id}
                        session={s}
                        selected={s.id === selectedSessionId}
                        onSelect={onNavigate}
                      />
                    ))}
                    {archived.length > archivedShown && (
                      <Button
                        variant="subtle"
                        size="compact-xs"
                        color="gray"
                        onClick={() => setArchivedShown((n) => n + ARCHIVED_PAGE)}
                      >
                        Show {Math.min(ARCHIVED_PAGE, archived.length - archivedShown)} more of{' '}
                        {archived.length - archivedShown}
                      </Button>
                    )}
                  </>
                )}
              </>
            )}
            {activeProjectKey && <UnlinkedCheckouts activeKey={activeProjectKey} />}
          </Stack>
        )}
      </ScrollArea>
      )}
      <Box px="sm" py={6} style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
        <SegmentedControl
          fullWidth
          size="xs"
          value={sidebarMode}
          onChange={(v) => setSidebarMode(v as SidebarMode)}
          data={[
            { value: 'sessions', label: 'Sessions' },
            { value: 'files', label: 'Files' },
          ]}
        />
      </Box>
    </Stack>
  );
}
