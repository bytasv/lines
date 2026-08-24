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
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconArchive,
  IconArchiveOff,
  IconBook,
  IconCircleCheck,
  IconCircleCheckFilled,
  IconChevronDown,
  IconCoins,
  IconEye,
  IconEyeOff,
  IconGitBranch,
  IconLink,
  IconPlus,
  IconRoute,
  IconTrash,
} from '@tabler/icons-react';
import { useLocalStorage } from '@mantine/hooks';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SessionMeta } from '@lines/shared';
import { findWorktree, projectPaths, projectRoots } from '@lines/shared';
import { formatDuration, isWorkflowFinished, sessionRowMeta } from '../lib/format';
import { useCan, useIsGuest, useSessionMachine } from '../lib/can';
import { useIdentityResolver } from '../lib/identity';
import type { SidebarMode } from '../store';
import { projectAt, sessionsInProject, useStore } from '../store';
import { send } from '../ws';
import { FileTree } from './FileTree';

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

function SessionRow({ session, selected }: { session: SessionMeta; selected: boolean }) {
  const status = sessionRowMeta(session);
  // deleteSession/archiveSession are permanently owner-only: a guest never gets
  // the hover controls, rather than getting ones that answer with an error.
  const guest = useIsGuest();
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
    if (opts.confirmFirst && !confirm(`Delete session "${session.name}"?`)) return;
    setActionError(null);
    if (send({ type: 'deleteSession', sessionId: session.id })) setDeleting(true);
  };
  // A session with no real prompt yet is safe to delete outright; others archive first.
  const isNew = session.nameAuto === true;
  // Ran its workflow to the end but not manually completed — and never allowed to
  // mask a session that still needs the user.
  const finished = !session.completed && !status.actionable && isWorkflowFinished(session);
  const wide = session.completed || finished;

  return (
    <UnstyledButton
      component={Link}
      to={`/session/${session.id}`}
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
              {session.completed ? (
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
            {!hovered && status.actionable ? (
              <Badge
                variant="light"
                color={status.color}
                px={4}
                h={12}
                style={{ fontSize: 8 }}
              >
                {status.label}
              </Badge>
            ) : (
              <>
                <Text size="xs" c="dimmed">
                  {new Date(session.createdAt).toLocaleDateString('en-GB')}
                </Text>
                {session.totalCostUsd != null && (
                  <Text size="xs" c="dimmed">
                    ${session.totalCostUsd.toFixed(2)}
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
          {guest ? null : session.archived ? (
            <>
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
            </>
          ) : isNew ? (
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
          ) : (
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
          )}
        </Group>
      </Group>
    </UnstyledButton>
  );
}

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
    <Popover width={320} position="top" withArrow shadow="md">
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
}: {
  onEditWorkflows: () => void;
  onBrowseRecipes: () => void;
}) {
  const sessions = useStore((s) => s.sessions);
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
  // '' = raw session, otherwise workflow id.
  const [lastChoice, setLastChoice] = useLocalStorage<string>({
    key: 'lines.lastNewSessionChoice',
    defaultValue: '',
  });
  const lastWorkflow = [...workflows, ...sharedWorkflows].find((w) => w.id === lastChoice);
  // Persisted like `lastChoice`: running every new session in its own checkout is a
  // working habit, not a per-click decision.
  const [worktreeMode, setWorktreeMode] = useLocalStorage<boolean>({
    key: 'lines.newSessionWorktree',
    defaultValue: false,
  });

  const projectKeys = useStore((s) => s.projectKeys);
  const projects = useStore((s) => s.projects);
  const project = projectAt(projects, activeProject);
  const roots = project ? projectRoots(project) : [];
  const activeProjectKey = activeProject ? projectKeys[activeProject] ?? null : null;
  const projectSessions = sessionsInProject(sessions, projectKeys, project);
  /**
   * Sessions shared with this user that no project tab covers.
   *
   * A guest gets no project list — the host's folders are not theirs to browse —
   * so `sessionsInProject` matches nothing and every shared session would be
   * held in the store and rendered nowhere. They get a group of their own rather
   * than a synthesised project tab, which would imply the guest can open files
   * and start sessions in a folder they have no standing in.
   */
  const shared = access
    ? Object.values(sessions)
        .filter((s) => !s.archived && !projectSessions.some((p) => p.id === s.id))
        .sort((a, b) => b.createdAt - a.createdAt)
    : [];
  const list = projectSessions
    .filter((s) => !s.archived)
    .sort((a, b) => b.createdAt - a.createdAt);
  const archived = projectSessions
    .filter((s) => s.archived)
    .sort((a, b) => (b.archivedAt ?? b.createdAt) - (a.archivedAt ?? a.createdAt));

  // Model/mode come from the settings modal (header gear); caveman still
  // inherits from the project's latest session.
  const newSessionDefaults = useStore((s) => s.newSessionDefaults);
  const markSessionCreatePending = useStore((s) => s.markSessionCreatePending);
  const actionError = useStore((s) => s.actionError);
  const setSidebarActionError = useStore((s) => s.setActionError);
  const worktreePending = useStore((s) => s.worktreePending);
  const setWorktreePending = useStore((s) => s.setWorktreePending);
  const createSession = (workflowId?: string) => {
    if (!activeProject) return;
    const last = list[0];
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
      caveman: last?.caveman ?? { enabled: true, level: 'full' },
      workflowId,
      // Empty object = let the server name the branch and the path.
      ...(worktreeMode ? { worktree: {} } : {}),
    });
    setLastChoice(workflowId ?? '');
  };

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
  const activeFile = useStore((s) =>
    activeProject ? s.openFiles[activeProject]?.active ?? null : null,
  );

  return (
    <Stack gap={0} h="100%">
      <Group px="sm" py="xs" justify="space-between">
        <Text size="xs" fw={600} c="dimmed" tt="uppercase">
          {sidebarMode === 'files' ? 'Files' : 'Sessions'}
        </Text>
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
      {/* A guest creates sessions only with an explicit machine-scope grant: a
          session share has no folder to create in, and the bridge refuses it. */}
      {sidebarMode === 'sessions' && canCreate && (
        <Box px="sm" pb="xs" ref={setCreateRow}>
          <Button.Group style={{ width: '100%' }}>
            <Button
              style={{ flex: 1 }}
              leftSection={worktreePending ? <Loader size={12} color="white" /> : <IconPlus size={14} />}
              onClick={() => createSession(lastWorkflow?.id)}
              disabled={!activeProject || worktreePending}
            >
              {lastWorkflow ? lastWorkflow.name : 'New session'}
              {worktreeMode ? ' in worktree' : ''}
            </Button>
            {/* Always rendered now: the worktree toggle lives here, so the split
                half can no longer depend on a workflow existing. */}
            <Menu position="bottom-end" width={menuWidth ?? 240}>
              <Menu.Target>
                <Button px={6} disabled={!activeProject}>
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
                      body: { width: '100%', alignItems: 'center', justifyContent: 'space-between' },
                      labelWrapper: { marginInlineEnd: 'var(--mantine-spacing-sm)' },
                    }}
                  />
                </Box>
                <Menu.Divider />
                <Menu.Item onClick={() => createSession()}>New session</Menu.Item>
                {workflows.length > 0 && (
                  <>
                    <Menu.Divider />
                    <Menu.Label>With workflow</Menu.Label>
                    {workflows.map((w) => (
                      <Menu.Item key={w.id} onClick={() => createSession(w.id)}>
                        {w.name}
                      </Menu.Item>
                    ))}
                  </>
                )}
                {sharedWorkflows.length > 0 && (
                  <>
                    <Menu.Divider />
                    <Menu.Label>Shared by others</Menu.Label>
                    {sharedWorkflows.map((w) => (
                      <Menu.Item
                        key={w.id}
                        onClick={() => createSession(w.id)}
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
      <ScrollArea style={{ flex: 1 }} px={6}>
        {sidebarMode === 'files' ? (
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
                  <SessionRow key={s.id} session={s} selected={s.id === selectedSessionId} />
                ))}
              </>
            )}
            {list.map((s) => (
              <SessionRow key={s.id} session={s} selected={s.id === selectedSessionId} />
            ))}
            {list.length === 0 && archived.length === 0 && shared.length === 0 && (
              <Text size="xs" c="dimmed" ta="center" pt="lg">
                {access ? 'Nothing has been shared with you yet' : 'No sessions in this project yet'}
              </Text>
            )}
            {archived.length > 0 && (
              <>
                <Group gap={4} justify="space-between" wrap="nowrap" px="sm" pt="sm">
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
                {showArchived &&
                  archived.map((s) => (
                    <SessionRow key={s.id} session={s} selected={s.id === selectedSessionId} />
                  ))}
              </>
            )}
            {activeProjectKey && <UnlinkedCheckouts activeKey={activeProjectKey} />}
          </Stack>
        )}
      </ScrollArea>
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
