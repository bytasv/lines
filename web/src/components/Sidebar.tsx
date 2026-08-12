import {
  ActionIcon,
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
  IconLink,
  IconPlus,
  IconRoute,
  IconTrash,
} from '@tabler/icons-react';
import { useLocalStorage } from '@mantine/hooks';
import type { CSSProperties } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SessionMeta } from '@lines/shared';
import { projectRoots } from '@lines/shared';
import { formatDuration, isWorkflowFinished, sessionRowMeta } from '../lib/format';
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
  const { overflowing, check } = useOverflow();
  const [hovered, setHovered] = useState(false);
  // A delete that has been sent but not echoed back. No optimistic removal: the
  // `sessionDeleted` echo stays the only thing that takes a row off the list, so a
  // delete that never lands leaves the row visible rather than silently "working".
  const [deleting, setDeleting] = useState(false);
  const setActionError = useStore((s) => s.setActionError);
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
      }}
    >
      <Group gap="xs" wrap="nowrap" justify="space-between">
        <Box style={{ minWidth: 0 }}>
          <Group gap={5} wrap="nowrap">
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
          {session.archived ? (
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

  const dismissedCheckouts = useStore((s) => s.dismissedCheckouts);
  const setCheckoutDismissed = useStore((s) => s.setCheckoutDismissed);

  const { unlinked, dismissed } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of Object.values(sessions)) {
      if (!s.cwd || s.cwd === activeProject || projectKeys[s.cwd]) continue;
      counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
    }
    const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const hidden = new Set(dismissedCheckouts);
    return {
      unlinked: byCount.filter(([cwd]) => !hidden.has(cwd)),
      dismissed: byCount.filter(([cwd]) => hidden.has(cwd)),
    };
  }, [sessions, projectKeys, activeProject, dismissedCheckouts]);

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
  const activeProject = useStore((s) => s.activeProject);
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

  const projectKeys = useStore((s) => s.projectKeys);
  const projects = useStore((s) => s.projects);
  const project = projectAt(projects, activeProject);
  const roots = project ? projectRoots(project) : [];
  const activeProjectKey = activeProject ? projectKeys[activeProject] ?? null : null;
  const projectSessions = sessionsInProject(sessions, projectKeys, project);
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
  const createSession = (workflowId?: string) => {
    if (!activeProject) return;
    const last = list[0];
    // Records the intent that lets the resulting upsert take the selection; the
    // reducer no longer guesses from `createdAt` (a timestamp from another machine).
    markSessionCreatePending();
    send({
      type: 'createSession',
      name: 'New session',
      cwd: activeProject,
      model: newSessionDefaults.model,
      permissionMode: newSessionDefaults.permissionMode,
      caveman: last?.caveman ?? { enabled: true, level: 'full' },
      workflowId,
    });
    setLastChoice(workflowId ?? '');
  };

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
      {sidebarMode === 'sessions' && (
        <Box px="sm" pb="xs">
          <Button.Group style={{ width: '100%' }}>
            <Button
              style={{ flex: 1 }}
              leftSection={<IconPlus size={14} />}
              onClick={() => createSession(lastWorkflow?.id)}
              disabled={!activeProject}
            >
              {lastWorkflow ? lastWorkflow.name : 'New session'}
            </Button>
            {(workflows.length > 0 || sharedWorkflows.length > 0) && (
              <Menu position="bottom-end" width={240}>
                <Menu.Target>
                  <Button px={6} disabled={!activeProject}>
                    <IconChevronDown size={14} />
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
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
            )}
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
            {list.map((s) => (
              <SessionRow key={s.id} session={s} selected={s.id === selectedSessionId} />
            ))}
            {list.length === 0 && archived.length === 0 && (
              <Text size="xs" c="dimmed" ta="center" pt="lg">
                No sessions in this project yet
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
