import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Group,
  Loader,
  Menu,
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
  IconCircleCheck,
  IconChevronDown,
  IconPlus,
  IconRoute,
  IconTrash,
} from '@tabler/icons-react';
import { useLocalStorage } from '@mantine/hooks';
import type { CSSProperties } from 'react';
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SessionMeta, SessionStatus } from '@claude-ui/shared';
import type { SidebarMode } from '../store';
import { useStore } from '../store';
import { send } from '../ws';
import { FileTree } from './FileTree';

const STATUS_META: Record<SessionStatus, { color: string; label: string }> = {
  idle: { color: 'gray', label: 'idle' },
  running: { color: 'blue', label: 'running' },
  done: { color: 'green', label: 'done' },
  'waiting-permission': { color: 'yellow', label: 'needs permission' },
  'waiting-approval': { color: 'orange', label: 'needs approval' },
  error: { color: 'red', label: 'error' },
};

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
  const status = STATUS_META[session.status] ?? STATUS_META.idle;
  const { overflowing, check } = useOverflow();
  // A session with no real prompt yet is safe to delete outright; others archive first.
  const isNew = session.nameAuto === true;

  return (
    <UnstyledButton
      component={Link}
      to={`/session/${session.id}`}
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
            <Center w={session.completed ? 14 : 10} style={{ flex: session.completed ? '0 0 14px' : '0 0 10px' }}>
              {session.completed ? (
                <IconCircleCheck size={14} color="var(--mantine-color-green-6)" style={{ flexShrink: 0 }} />
              ) : session.status === 'running' ? (
                <Loader size={10} />
              ) : (
                <span
                  className="status-dot"
                  data-pulse={session.status !== 'idle' ? true : undefined}
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
          <Group gap={6} wrap="nowrap">
            <Text size="xs" c="dimmed">
              {new Date(session.createdAt).toLocaleDateString()}
            </Text>
            {session.workflow && (
              <Badge variant="light" color="grape" size="xs" px={5}>
                wf
              </Badge>
            )}
            {session.status !== 'idle' &&
              session.status !== 'running' &&
              session.status !== 'done' && (
              <Badge variant="light" color={status.color} size="xs" px={5}>
                {status.label}
              </Badge>
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
              <Tooltip label="Delete session">
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="gray"
                  onClick={(e) => {
                    stop(e);
                    if (confirm(`Delete session "${session.name}"?`)) {
                      send({ type: 'deleteSession', sessionId: session.id });
                    }
                  }}
                >
                  <IconTrash size={13} />
                </ActionIcon>
              </Tooltip>
            </>
          ) : isNew ? (
            <Tooltip label="Delete session">
              <ActionIcon
                size="xs"
                variant="subtle"
                color="gray"
                onClick={(e) => {
                  stop(e);
                  send({ type: 'deleteSession', sessionId: session.id });
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

export function Sidebar({ onEditWorkflows }: { onEditWorkflows: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const workflows = useStore((s) => s.workflows);
  const selectedSessionId = useStore((s) => s.selectedSessionId);
  const activeProject = useStore((s) => s.activeProject);
  const [showArchived, setShowArchived] = useLocalStorage<boolean>({
    key: 'claude-ui.showArchived',
    defaultValue: true,
  });
  // '' = raw session, otherwise workflow id.
  const [lastChoice, setLastChoice] = useLocalStorage<string>({
    key: 'claude-ui.lastNewSessionChoice',
    defaultValue: '',
  });
  const lastWorkflow = workflows.find((w) => w.id === lastChoice);

  const projectSessions = Object.values(sessions).filter((s) => s.cwd === activeProject);
  const list = projectSessions
    .filter((s) => !s.archived)
    .sort((a, b) => b.createdAt - a.createdAt);
  const archived = projectSessions
    .filter((s) => s.archived)
    .sort((a, b) => (b.archivedAt ?? b.createdAt) - (a.archivedAt ?? a.createdAt));

  // Model/mode come from the settings modal (header gear); caveman still
  // inherits from the project's latest session.
  const newSessionDefaults = useStore((s) => s.newSessionDefaults);
  const createSession = (workflowId?: string) => {
    if (!activeProject) return;
    const last = list[0];
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
          <Tooltip label="Workflows">
            <ActionIcon variant="subtle" color="gray" size="sm" onClick={onEditWorkflows}>
              <IconRoute size={15} />
            </ActionIcon>
          </Tooltip>
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
            {workflows.length > 0 && (
              <Menu position="bottom-end" width={220}>
                <Menu.Target>
                  <Button px={6} disabled={!activeProject}>
                    <IconChevronDown size={14} />
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item onClick={() => createSession()}>New session</Menu.Item>
                  <Menu.Divider />
                  <Menu.Label>With workflow</Menu.Label>
                  {workflows.map((w) => (
                    <Menu.Item key={w.id} onClick={() => createSession(w.id)}>
                      {w.name}
                    </Menu.Item>
                  ))}
                </Menu.Dropdown>
              </Menu>
            )}
          </Button.Group>
        </Box>
      )}
      <ScrollArea style={{ flex: 1 }} px={6}>
        {sidebarMode === 'files' ? (
          activeProject ? (
            <Box pb="sm">
              <FileTree
                key={activeProject}
                root={activeProject}
                onFileClick={openFileTab}
                selectedPath={activeFile}
              />
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
