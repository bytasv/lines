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
  IconArrowDown,
  IconArrowUp,
  IconBell,
  IconBellOff,
  IconFolderPlus,
  IconFolderSymlink,
  IconPencil,
  IconGitBranch,
  IconLink,
  IconLock,
  IconPlus,
  IconRoute,
  IconSearch,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useHotkeys, useLocalStorage } from '@mantine/hooks';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  DragDropContext,
  Draggable,
  Droppable,
  type DraggableProvidedDragHandleProps,
  type DropResult,
} from '@hello-pangea/dnd';
import type {
  PermissionMode,
  ProjectSessionPrefs,
  ReasoningEffort,
  SessionGroup,
  SessionMeta,
  WorkflowDef,
  WorkflowStepOverride,
} from '@lines/shared';
import { findWorktree, hasEstimatedSpend, projectPaths, projectRoots, rootsForCwd } from '@lines/shared';
import type { SessionSort } from '../lib/format';
import {
  compareSessions,
  formatDuration,
  formatSpendUsd,
  isWorkflowFinished,
  sessionRowMeta,
  withLiveSpend,
} from '../lib/format';
import { useCan, useCanOnSession, useSessionMachine } from '../lib/can';
import { searchSessions } from '../lib/files';
import { inlineWorkflow, sessionsOnMachine, uncoveredSharedSessions } from '../lib/machines';
import { useIsPhone, useReveal } from '../lib/layout';
import { MOD, newSessionHotkey } from '../lib/platform';
import { ConfirmModal } from './ConfirmModal';
import { SingleRunModal } from './workflow/SingleRunModal';
import { useIdentityResolver } from '../lib/identity';
import type { SidebarMode, SidebarSearchScope } from '../store';
import { activeGroupKey, groupKeyOf, prefsFor, projectAt, selectSidebarMode, sessionsInProject, useStore } from '../store';
import { send } from '../ws';
import { FileSearchResults, FlagToggle } from './FileSearchPanel';
import { FileTree } from './FileTree';
import { SearchPlaceholder, SessionSearchResults } from './SessionSearchResults';
import { GroupNamePopover, MUTE_TOOLTIP, SessionGroupSection } from './SessionGroupSection';

/**
 * Archived rows rendered before the "show more" step. Uncapped, a project with a
 * few hundred finished sessions paid for every one of them on the first paint and
 * on every re-render — and Archived starts expanded.
 */
const ARCHIVED_PAGE = 20;

/**
 * Collapsed sidebar sections, per browser: project group key -> collapsed group
 * ids. The reserved `ARCHIVED_SECTION` id stands for the Archived section, so
 * every project keeps its own Archived state too.
 */
const COLLAPSED_GROUPS_KEY = 'lines.collapsedGroups';
const ARCHIVED_SECTION = 'archived';
/** The global Archived toggle `lines.collapsedGroups` replaced; migrated once. */
const LEGACY_SHOW_ARCHIVED_KEY = 'lines.showArchived';
const NO_GROUPS: SessionGroup[] = [];
/** Session drop targets: Active, `group:<id>` per user group, and `ARCHIVED_SECTION`. */
const ACTIVE_DROP = 'active';
const GROUP_DROP_PREFIX = 'group:';

/**
 * A section rows can be dragged into. `label` gives an empty (or collapsed)
 * section something to drop on, below whatever it already shows; otherwise the
 * section's own content is the target.
 */
function SessionDrop({ id, label, children }: { id: string; label?: string; children: ReactNode }) {
  return (
    <Droppable droppableId={id} type="SESSION">
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.droppableProps}
          style={{
            borderRadius: 8,
            minHeight: label ? 28 : 4,
            background: snapshot.isDraggingOver ? 'var(--mantine-color-default-hover)' : undefined,
          }}
        >
          {children}
          {label && (
            <Text size="xs" c="dimmed" ta="center" py={6}>
              {label}
            </Text>
          )}
          {provided.placeholder}
        </div>
      )}
    </Droppable>
  );
}

/** Sidebar sort menu, in menu order. `status` is the default — see `compareSessions`. */
const SORT_OPTIONS: { value: SessionSort; label: string }[] = [
  { value: 'status', label: 'Status' },
  { value: 'activity', label: 'Last active' },
  { value: 'created', label: 'Created' },
  { value: 'manual', label: 'Manual' },
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
  groups,
  groupKey,
}: {
  session: SessionMeta;
  selected: boolean;
  /** Phone only: the sidebar is a drawer there, and it covers what was picked. */
  onSelect?: () => void;
  /** The project's sidebar groups, for "Move to group". */
  groups?: SessionGroup[];
  /** Where the project's groups are stored; absent hides "Move to group" (guests, shared rows). */
  groupKey?: string | null;
}) {
  const status = sessionRowMeta(session);
  // Settled total plus the in-flight turn's live estimate, while one runs.
  const liveSpend = useStore((s) => s.turnSpend[session.id]);
  const cost = withLiveSpend(session.totalCostUsd, liveSpend, hasEstimatedSpend(session.costByModel));
  // Archive/complete and delete need Full access on a shared machine: a guest
  // without them never gets the controls, rather than ones that answer with an error.
  // A dev bridge's read-only session (the installed app runs it) takes no actions either.
  const canManage = useCanOnSession(session.id, 'manageSessions') && !session.readOnly;
  const canDelete = useCanOnSession(session.id, 'deleteSessions') && !session.readOnly;
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
  // Same gating as archive: an archived row shows only under Archived, so it has
  // no group to move between until it is unarchived.
  const canGroup = canManage && !session.archived && !!groupKey;
  const createGroup = useStore((s) => s.createGroup);
  const [namingGroup, setNamingGroup] = useState(false);
  const moveToGroup = (groupId: string | null) => {
    setActionError(null);
    send({ type: 'setSessionGroup', sessionId: session.id, groupId });
  };
  const inGroup = !!groups?.some((g) => g.id === session.groupId);
  const groupItems = (
    <>
      {inGroup && (
        <Menu.Item onClick={() => moveToGroup(null)}>Active</Menu.Item>
      )}
      {groups
        ?.filter((g) => g.id !== session.groupId)
        .map((g) => (
          <Menu.Item key={g.id} onClick={() => moveToGroup(g.id)}>
            {g.name}
          </Menu.Item>
        ))}
      {(inGroup || !!groups?.length) && <Menu.Divider />}
      <Menu.Item leftSection={<IconFolderPlus size={14} />} onClick={() => setNamingGroup(true)}>
        New group…
      </Menu.Item>
    </>
  );

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
            {session.readOnly && (
              <Tooltip label="Read-only: runs in the installed Lines app" openDelay={300} withArrow>
                <Center w={13} h={13} c="orange.6" style={{ flex: '0 0 13px' }}>
                  <IconLock size={12} />
                </Center>
              </Tooltip>
            )}
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
        <GroupNamePopover
          opened={namingGroup}
          onClose={() => setNamingGroup(false)}
          submitLabel="Create"
          onSubmit={(name) => groupKey && moveToGroup(createGroup(groupKey, name))}
        >
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
                  {canGroup && (
                    <Menu.Sub>
                      <Menu.Sub.Target>
                        <Menu.Sub.Item leftSection={<IconFolderSymlink size={16} />}>Move to group</Menu.Sub.Item>
                      </Menu.Sub.Target>
                      <Menu.Sub.Dropdown onClick={stop}>{groupItems}</Menu.Sub.Dropdown>
                    </Menu.Sub>
                  )}
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
        </GroupNamePopover>
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

/**
 * A user-made group in the sidebar: the shared section plus its ⋯ menu (rename,
 * reorder, mute, delete). Move up/down duplicate the header drag for touch.
 */
function UserGroupSection({
  group,
  index,
  total,
  groupKey,
  sessions,
  collapsed,
  onToggle,
  canEdit,
  dragHandleProps,
  children,
}: {
  group: SessionGroup;
  index: number;
  total: number;
  groupKey: string;
  sessions: SessionMeta[];
  collapsed: boolean;
  onToggle: () => void;
  canEdit: boolean;
  dragHandleProps?: DraggableProvidedDragHandleProps | null;
  children: ReactNode;
}) {
  const renameGroup = useStore((s) => s.renameGroup);
  const deleteGroup = useStore((s) => s.deleteGroup);
  const moveGroup = useStore((s) => s.moveGroup);
  const toggleGroupMuted = useStore((s) => s.toggleGroupMuted);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const count = sessions.length;
  return (
    <>
      <SessionGroupSection
        title={group.name}
        sessions={sessions}
        collapsed={collapsed}
        onToggle={onToggle}
        muted={group.muted}
        dragHandleProps={dragHandleProps}
        rename={{
          opened: renaming,
          onClose: () => setRenaming(false),
          onSubmit: (name) => renameGroup(groupKey, group.id, name),
        }}
        menu={
          canEdit && (
            <>
              <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => setRenaming(true)}>
                Rename
              </Menu.Item>
              <Menu.Item
                leftSection={<IconArrowUp size={14} />}
                disabled={index === 0}
                onClick={() => moveGroup(groupKey, index, index - 1)}
              >
                Move up
              </Menu.Item>
              <Menu.Item
                leftSection={<IconArrowDown size={14} />}
                disabled={index === total - 1}
                onClick={() => moveGroup(groupKey, index, index + 1)}
              >
                Move down
              </Menu.Item>
              <Tooltip label={MUTE_TOOLTIP} multiline maw={260} withArrow position="left">
                <Menu.Item
                  leftSection={group.muted ? <IconBell size={14} /> : <IconBellOff size={14} />}
                  onClick={() => toggleGroupMuted(groupKey, group.id)}
                >
                  {group.muted ? 'Unmute' : 'Mute'}
                </Menu.Item>
              </Tooltip>
              <Menu.Divider />
              <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => setConfirmingDelete(true)}>
                Delete group
              </Menu.Item>
            </>
          )
        }
      >
        {children}
      </SessionGroupSection>
      <ConfirmModal
        opened={confirmingDelete}
        title="Delete group"
        message={
          count
            ? `Delete group “${group.name}”? Its ${count === 1 ? 'session returns' : `${count} sessions return`} to Active.`
            : `Delete group “${group.name}”?`
        }
        confirmLabel="Delete group"
        confirmColor="red"
        onConfirm={() => {
          setConfirmingDelete(false);
          deleteGroup(groupKey, group.id);
        }}
        onCancel={() => setConfirmingDelete(false)}
      />
    </>
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
  const canManageGroups = useCan('manageSessions');
  const activeProject = useStore((s) => s.activeProject);
  const access = useStore((s) => s.access);
  const [collapsedGroups, setCollapsedGroups] = useLocalStorage<Record<string, string[]>>({
    key: COLLAPSED_GROUPS_KEY,
    defaultValue: {},
  });
  const [archivedShown, setArchivedShown] = useState(ARCHIVED_PAGE);
  /**
   * Sort, new-session choice and worktree toggle follow the selected project.
   * Keyed by `activeGroupKey`, not `groupKey` below: that one is null for a
   * guest, whose prefs still apply — they just stay in this browser.
   */
  const prefsKey = useStore(activeGroupKey);
  const sessionPrefs = useStore((s) => s.sessionPrefs);
  const legacySidebarMode = useStore((s) => s.sidebarMode);
  const setSessionPrefs = useStore((s) => s.setSessionPrefs);
  const prefs = useMemo(
    () => prefsFor({ sessionPrefs, sidebarMode: legacySidebarMode }, prefsKey),
    [sessionPrefs, legacySidebarMode, prefsKey],
  );
  const setPrefs = (patch: ProjectSessionPrefs) => {
    if (prefsKey) setSessionPrefs(prefsKey, patch);
  };
  // '' = raw session, otherwise workflow id.
  const lastChoice = prefs.newSessionChoice;
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
  const worktreeMode = prefs.worktree;
  // Defaults to urgency order: the session that needs the user must not sit
  // below newer idle ones in a busy project.
  const sessionSort = prefs.sort;

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
  // Groups are the owner's: a guest never receives settings, so their list stays flat.
  const groupKey = activeProject && !access ? groupKeyOf(projectKeys, activeProject) : null;
  const groups = useStore((s) => (groupKey ? s.sessionGroups[groupKey] : undefined)) ?? NO_GROUPS;
  const createGroup = useStore((s) => s.createGroup);
  const moveGroup = useStore((s) => s.moveGroup);
  const manualOrder = useStore((s) => (groupKey ? s.sessionOrder[groupKey] : undefined));
  const setSessionOrder = useStore((s) => s.setSessionOrder);
  const compare = useMemo(() => compareSessions(sessionSort, manualOrder), [sessionSort, manualOrder]);
  const [namingGroup, setNamingGroup] = useState(false);
  const collapsed = new Set(groupKey ? (collapsedGroups[groupKey] ?? []) : []);
  const toggleCollapsed = (id: string) => {
    if (!groupKey) return;
    setCollapsedGroups((all) => {
      const cur = all[groupKey] ?? [];
      const next = cur.includes(id) ? cur.filter((g) => g !== id) : [...cur, id];
      const out = { ...all };
      if (next.length) out[groupKey] = next;
      else delete out[groupKey];
      return out;
    });
  };
  // The old global toggle: a hidden Archived carries over to the project open
  // when this first runs, then the key goes.
  useEffect(() => {
    if (!groupKey) return;
    const legacy = localStorage.getItem(LEGACY_SHOW_ARCHIVED_KEY);
    if (legacy === null) return;
    localStorage.removeItem(LEGACY_SHOW_ARCHIVED_KEY);
    if (legacy !== 'false') return;
    setCollapsedGroups((all) => {
      const cur = all[groupKey] ?? [];
      return cur.includes(ARCHIVED_SECTION) ? all : { ...all, [groupKey]: [...cur, ARCHIVED_SECTION] };
    });
  }, [groupKey, setCollapsedGroups]);
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
  // "Shared with me": session-scope guests only — see `uncoveredSharedSessions`.
  const shared = useMemo(
    () => uncoveredSharedSessions(machineSessions, projects, projectKeys, access?.scope).sort(compare),
    [access?.scope, projects, machineSessions, projectKeys, compare],
  );
  const live = projectSessions.filter((s) => !s.archived).sort(compare);
  // A `groupId` naming no group of this project (deleted, or never synced here)
  // reads as ungrouped, so the session falls back into Active.
  const groupIds = new Set(groups.map((g) => g.id));
  const list = live.filter((s) => !s.groupId || !groupIds.has(s.groupId));
  const grouped = groups.map((group) => ({
    group,
    sessions: live.filter((s) => s.groupId === group.id),
  }));
  // Same comparator as the live list rather than an `archivedAt` key of its own:
  // archiving is an upsert, so `status` and `activity` still put the most recently
  // archived first, and `created` means creation order — which is what it says.
  // Archived is never hand-placed: under `manual` it keeps "recently touched first".
  const archived = projectSessions
    .filter((s) => s.archived)
    .sort(sessionSort === 'manual' ? compareSessions('activity') : compare);

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
  /**
   * Launch a new session. Anything left out of `opts` comes from the new-session
   * defaults and the worktree switch. `once` is the Single run window: the launch
   * is not remembered as the last choice, so the primary button keeps its label.
   * `reasoningEffort` counts when present as a key, even undefined (= Auto).
   */
  const createSession = (
    workflowId?: string,
    opts?: {
      stepOverrides?: (WorkflowStepOverride | null)[];
      model?: string;
      reasoningEffort?: ReasoningEffort;
      permissionMode?: PermissionMode;
      worktree?: boolean;
      once?: boolean;
    },
  ) => {
    if (!activeProject) return;
    const stepOverrides = opts?.stepOverrides;
    const worktree = opts?.worktree ?? worktreeMode;
    const reasoningEffort =
      opts && 'reasoningEffort' in opts ? opts.reasoningEffort : newSessionDefaults.reasoningEffort;
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
    if (worktree) {
      setSidebarActionError(null);
      setWorktreePending(true);
    }
    send({
      type: 'createSession',
      name: 'New session',
      cwd: activeProject,
      model: opts?.model ?? newSessionDefaults.model,
      permissionMode: opts?.permissionMode ?? newSessionDefaults.permissionMode,
      reasoningEffort,
      workflowId,
      ...(workflowDef ? { workflowDef } : {}),
      ...(workflowId && stepOverrides?.some(Boolean) ? { stepOverrides } : {}),
      // Empty object = let the server name the branch and the path.
      ...(worktree ? { worktree: {} } : {}),
    });
    if (!opts?.once) setPrefs({ newSessionChoice: workflowId ?? '' });
    // On a phone the drawer sits over the composer the user is about to type in.
    onNavigate?.();
  };

  /** The Single run window's starting workflow: '' = bare, null = closed. */
  const [singleRunFor, setSingleRunFor] = useState<string | null>(null);
  /** The def a launch of `workflowId` runs, for picking its per-step models. */
  const resolveWorkflow = (workflowId: string): WorkflowDef | undefined => {
    // An own workflow on a shared machine is tuned in its inlined form: its refs
    // do not resolve against the host's step library.
    const inlined = ownWorkflows.some((w) => w.id === workflowId) ? ownInline(workflowId) : null;
    return (inlined?.ok ? inlined.def : null) ?? [...workflows, ...sharedWorkflows].find((w) => w.id === workflowId);
  };
  /**
   * A new-session click. Cmd/Ctrl+click opens the Single run window instead of
   * launching, bare or not; a plain click launches as before.
   */
  const createFromClick = (e: ReactMouseEvent, workflowId?: string) => {
    if (e.metaKey || e.ctrlKey) {
      setSingleRunFor(workflowId ?? '');
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
  const modHint = `${MOD}-click for a single run`;

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

  const sidebarMode = useStore(selectSidebarMode);
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
      : [...shared, ...list, ...grouped.flatMap((g) => g.sessions), ...archived].map((s) => s.id).join('\n');
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
  // Session drag: rows move between Active, the user's groups and Archived. Order
  // inside a section stays the sort's, so only the destination section matters.
  const [draggingSession, setDraggingSession] = useState(false);
  const canDragSessions = !!groupKey && canManageGroups;
  const sessionRows = (rows: SessionMeta[]) =>
    rows.map((s, i) => (
      <Draggable key={s.id} draggableId={s.id} index={i} isDragDisabled={!canDragSessions || !!s.readOnly}>
        {(dragProvided) => (
          <div ref={dragProvided.innerRef} {...dragProvided.draggableProps} {...dragProvided.dragHandleProps}>
            <SessionRow
              session={s}
              selected={s.id === selectedSessionId}
              onSelect={onNavigate}
              groups={groups}
              groupKey={groupKey}
            />
          </div>
        )}
      </Draggable>
    ));
  /** The rows a session drop target shows, in display order. */
  const sectionRows = (droppableId: string): SessionMeta[] =>
    droppableId === ACTIVE_DROP
      ? list
      : droppableId === ARCHIVED_SECTION
        ? archived
        : (grouped.find((g) => `${GROUP_DROP_PREFIX}${g.group.id}` === droppableId)?.sessions ?? []);
  /**
   * Write the manual order with the dragged session placed where it was dropped.
   * The base is what the sidebar shows right now, so switching from an automatic
   * sort keeps that order as the starting point. Placed ids this machine's list
   * does not show are kept while the store still holds them (another machine's
   * sessions in this project); the rest are dropped so the list does not grow.
   */
  const placeSession = (sessionId: string, droppableId: string, index: number) => {
    if (!groupKey || droppableId === ARCHIVED_SECTION) return;
    const shown = [...list, ...grouped.flatMap((g) => g.sessions)].map((s) => s.id);
    const shownSet = new Set(shown);
    const kept = (manualOrder ?? []).filter(
      (id) => !shownSet.has(id) && sessions[id] && !sessions[id].archived,
    );
    const ids = shown.filter((id) => id !== sessionId);
    const target = sectionRows(droppableId).filter((s) => s.id !== sessionId);
    const before = target[index];
    const after = target[target.length - 1];
    const at = before
      ? ids.indexOf(before.id)
      : after
        ? ids.indexOf(after.id) + 1
        : ids.length;
    ids.splice(at, 0, sessionId);
    setSessionOrder(groupKey, [...ids, ...kept]);
  };
  // A same-section drop under an automatic sort asks first: the sort would put
  // the row straight back, so the drop only means something in manual order.
  const [pendingReorder, setPendingReorder] = useState<DropResult | null>(null);
  const onSidebarDragEnd = (result: DropResult) => {
    setDraggingSession(false);
    const to = result.destination;
    if (!to || !groupKey) return;
    if (result.type === 'GROUP') {
      moveGroup(groupKey, result.source.index, to.index);
      return;
    }
    if (to.droppableId === result.source.droppableId) {
      if (to.index === result.source.index || to.droppableId === ARCHIVED_SECTION) return;
      if (sessionSort === 'manual') placeSession(result.draggableId, to.droppableId, to.index);
      else setPendingReorder(result);
      return;
    }
    const session = sessions[result.draggableId];
    if (!session) return;
    if (sessionSort === 'manual') placeSession(session.id, to.droppableId, to.index);
    if (to.droppableId === ARCHIVED_SECTION) {
      // Archiving keeps the group, so unarchiving later returns it there.
      send({ type: 'archiveSession', sessionId: session.id });
      return;
    }
    const groupId = to.droppableId.startsWith(GROUP_DROP_PREFIX)
      ? to.droppableId.slice(GROUP_DROP_PREFIX.length)
      : null;
    if (session.archived) send({ type: 'unarchiveSession', sessionId: session.id });
    // A grouped session dragged out of Archived into Active leaves its group too;
    // one whose stored group is already the target needs no second write.
    if ((session.groupId ?? null) !== groupId) {
      send({ type: 'setSessionGroup', sessionId: session.id, groupId });
    }
  };
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
                    onClick={() => setPrefs({ sort: opt.value })}
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
            {groupKey && canManageGroups && (
              <GroupNamePopover
                opened={namingGroup}
                onClose={() => setNamingGroup(false)}
                submitLabel="Create"
                onSubmit={(name) => createGroup(groupKey, name)}
              >
                <Tooltip label="New group">
                  <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => setNamingGroup(true)}>
                    <IconFolderPlus size={15} />
                  </ActionIcon>
                </Tooltip>
              </GroupNamePopover>
            )}
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
              label={`New session (${hotkey.label}) · ${modHint}`}
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
                    onChange={(e) => setPrefs({ worktree: e.currentTarget.checked })}
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
                <Menu.Item
                  onClick={(e) => createFromClick(e)}
                  rightSection={
                    !isPhone && (
                      <Text size="xs" c="dimmed">
                        {MOD}-click
                      </Text>
                    )
                  }
                >
                  New session
                </Menu.Item>
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
          {singleRunFor !== null && (
            <SingleRunModal
              workflows={workflows}
              ownWorkflows={ownWorkflows}
              foreignWorkflows={foreignWorkflows}
              resolveWorkflow={resolveWorkflow}
              initialWorkflowId={singleRunFor}
              defaults={newSessionDefaults}
              worktree={worktreeMode}
              onConfirm={(choice) => createSession(choice.workflowId, { ...choice, once: true })}
              onClose={() => setSingleRunFor(null)}
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
            <DragDropContext
              // Before capture, not on start: the empty Active/Archived drop zones it
              // reveals must exist before the library measures the droppables.
              onBeforeCapture={(before) => setDraggingSession(!before.draggableId.startsWith('group:'))}
              onDragEnd={onSidebarDragEnd}
            >
              <SessionDrop id={ACTIVE_DROP} label={draggingSession && list.length === 0 ? 'Active' : undefined}>
                {sessionRows(list)}
              </SessionDrop>
              {groupKey && grouped.length > 0 && (
                <Droppable droppableId="groups" type="GROUP">
                  {(dropProvided) => (
                    <div ref={dropProvided.innerRef} {...dropProvided.droppableProps}>
                      {grouped.map(({ group, sessions: members }, i) => (
                        <Draggable
                          key={group.id}
                          draggableId={`group:${group.id}`}
                          index={i}
                          isDragDisabled={!canManageGroups}
                          // The header is a button (it toggles the section); without this the
                          // library refuses to start a drag from it.
                          disableInteractiveElementBlocking
                        >
                          {(dragProvided) => (
                            <div ref={dragProvided.innerRef} {...dragProvided.draggableProps}>
                              {/* The whole section is the drop target, header included,
                                  so a collapsed group still takes a dropped session. */}
                              <SessionDrop
                                id={`${GROUP_DROP_PREFIX}${group.id}`}
                                // A new (empty) or collapsed group is just its header,
                                // too thin to aim at, so it opens a zone while dragging.
                                label={
                                  draggingSession && (members.length === 0 || collapsed.has(group.id))
                                    ? 'Drop here'
                                    : undefined
                                }
                              >
                                <UserGroupSection
                                  group={group}
                                  index={i}
                                  total={grouped.length}
                                  groupKey={groupKey}
                                  sessions={members}
                                  collapsed={collapsed.has(group.id)}
                                  onToggle={() => toggleCollapsed(group.id)}
                                  canEdit={canManageGroups}
                                  dragHandleProps={dragProvided.dragHandleProps}
                                >
                                  {sessionRows(members)}
                                </UserGroupSection>
                              </SessionDrop>
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {dropProvided.placeholder}
                    </div>
                  )}
                </Droppable>
              )}
              {projectSessions.length === 0 && shared.length === 0 && (
                <Text size="xs" c="dimmed" ta="center" pt="lg">
                  {access?.scope === 'session' ? 'Nothing has been shared with you yet' : 'No sessions in this project yet'}
                </Text>
              )}
              {/* Shown empty while a session is dragged, so archiving by drop works
                  in a project with nothing archived yet. */}
              {(archived.length > 0 || draggingSession) && (
                <>
                  {/* The active list above ends without a marker of its own, so the
                      rule is what says "everything below here is finished". */}
                  <Divider mt="xs" mx="sm" />
                  <SessionDrop id={ARCHIVED_SECTION}>
                    <SessionGroupSection
                      title="Archived"
                      sessions={archived}
                      collapsed={collapsed.has(ARCHIVED_SECTION)}
                      onToggle={() => toggleCollapsed(ARCHIVED_SECTION)}
                    >
                      {sessionRows(archived.slice(0, archivedShown))}
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
                    </SessionGroupSection>
                  </SessionDrop>
                </>
              )}
            </DragDropContext>
            <ConfirmModal
              opened={pendingReorder !== null}
              title="Switch to manual order?"
              message={`Sessions are sorted by ${(
                SORT_OPTIONS.find((o) => o.value === sessionSort)?.label ?? sessionSort
              ).toLowerCase()}, which would put this one straight back. Switch to manual order and keep the drop? The current order becomes the starting point; you can switch back from the sort menu.`}
              confirmLabel="Switch to manual"
              onConfirm={() => {
                const drop = pendingReorder;
                setPendingReorder(null);
                if (!drop?.destination) return;
                // Placed against the rows as sorted now, before the sort flips.
                placeSession(drop.draggableId, drop.destination.droppableId, drop.destination.index);
                setPrefs({ sort: 'manual' });
              }}
              onCancel={() => setPendingReorder(null)}
            />
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
