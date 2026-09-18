import {
  ActionIcon,
  Box,
  Center,
  CloseButton,
  Group,
  Indicator,
  Loader,
  Menu,
  ScrollArea,
  Text,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import {
  IconBooks,
  IconDots,
  IconFolder,
  IconFolderMinus,
  IconFolderOpen,
  IconFolderPlus,
  IconFolders,
  IconGitBranch,
  IconMoon,
  IconPlus,
  IconSettings,
  IconSun,
} from '@tabler/icons-react';
import { useEffect, useState, type CSSProperties } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Project, WorktreeInfo } from '@lines/shared';
import { projectRoots } from '@lines/shared';
import { ConfirmModal } from './ConfirmModal';
import { WorktreeModal } from './WorktreeModal';
import { projectStatusMeta } from '../lib/format';
import { sessionsInProject, useStore } from '../store';
import { useIsGuest, useIsLocalMachine } from '../lib/can';
import { send } from '../ws';
import { BrandMark } from './BrandMark';
import { SettingsModal } from './SettingsModal';
import { UsageIndicator } from './UsageIndicator';
import { UserMenu } from './UserMenu';

function baseName(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function ProjectTab({ project, active }: { project: Project; active: boolean }) {
  const path = project.path;
  const extraRoots = project.extraRoots ?? [];
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setFolderPickPending = useStore((s) => s.setFolderPickPending);
  const setFolderPickTarget = useStore((s) => s.setFolderPickTarget);
  const sessions = useStore((s) => s.sessions);
  const projectKeys = useStore((s) => s.projectKeys);
  const seen = useStore((s) => s.seenSessionStatus);
  // "Add folder…" shells out to Finder on the host, so it exists only for a
  // browser on the host. A remote device widens a project from the typed path.
  const isLocal = useIsLocalMachine();
  // The active project's sessions are already spelled out in the sidebar, so a
  // dot here would only be noise. Leaving keeps it quiet: opening the project
  // marked those states seen, and only a state the user hasn't seen re-lights it.
  const status = active
    ? null
    : projectStatusMeta(sessionsInProject(sessions, projectKeys, project), seen);
  const worktrees = project.worktrees ?? [];
  // The label stays the primary's basename; the tooltip is where every root fits.
  // Work trees get their own block: they are attributed to this tab but are not
  // folders its sessions may write in, so listing them together would misread.
  const rootList = [
    ...projectRoots(project),
    ...(worktrees.length
      ? [
          '',
          'Worktrees:',
          ...worktrees.map((w) => {
            const named = w.sessionId ? sessions[w.sessionId] : undefined;
            return `${named ? `${named.name} — ` : ''}${w.branch ?? 'detached'}`;
          }),
        ]
      : []),
  ].join('\n');

  const addFolder = () => {
    setFolderPickTarget(path);
    setFolderPickPending(true);
    send({ type: 'pickFolder' });
  };

  // The root awaiting confirmation. Removal widens/narrows what every session in
  // this tab may write to, so it goes through the same gate as deleting a step.
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  // null = closed; `{ target: null }` = the create form; a path = manage that record.
  const [worktreeModal, setWorktreeModal] = useState<{ target: string | null } | null>(null);

  /** A record whose session is gone still holds files, so it is labelled, not hidden. */
  const orphaned = (w: WorktreeInfo) => w.sessionId != null && !sessions[w.sessionId];

  /**
   * What to call a work tree. Its own name — `lines/wt-msrdj5nv` — says nothing,
   * because it was minted before there was a prompt to name it after. Its session's
   * name does, and the auto-titler rewrites that a few seconds in; reading it live
   * off the session means the row improves on its own without touching git, which
   * renaming a checked-out branch (or worse, its directory, which is the session's
   * identity) would.
   */
  const worktreeLabel = (w: WorktreeInfo) => {
    const branch = w.branch ?? 'detached';
    const session = w.sessionId ? sessions[w.sessionId] : undefined;
    if (orphaned(w)) return { title: branch, hint: 'orphaned' };
    return session ? { title: session.name, hint: branch } : { title: branch, hint: null };
  };

  return (
    <>
      <Tooltip
        label={status ? `${rootList} — ${status.label}` : rootList}
        openDelay={500}
        multiline
        // `multiline` alone collapses the newlines between roots.
        styles={{ tooltip: { whiteSpace: 'pre-line' } }}
      >
        <Box
          onClick={() => setActiveProject(path)}
          px={8}
          py={3}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            borderRadius: 6,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            background: active ? 'var(--mantine-color-default-hover)' : undefined,
          }}
        >
          {/* Fixed-width slot so the tab doesn't jitter as 13px icon ↔ 8px dot swap. */}
          <Center w={13} style={{ flex: '0 0 13px' }}>
            {status ? (
              // Every dot rendered here is actionable by construction — always pulse.
              <span
                className="status-dot"
                data-pulse
                style={
                  {
                    '--status-dot-color': `var(--mantine-color-${status.color}-6)`,
                    '--status-pulse-color': `var(--mantine-color-${status.color}-5)`,
                  } as CSSProperties
                }
              />
            ) : extraRoots.length ? (
              // Stacked folders: this tab is a workspace spanning several roots, so
              // its sessions can write outside the folder the label names.
              <IconFolders size={13} opacity={0.6} />
            ) : (
              <IconFolder size={13} opacity={0.6} />
            )}
          </Center>
          <Text size="xs" fw={active ? 600 : 400}>
            {baseName(path)}
          </Text>
          {/* Roots menu. Clicks are stopped on both the trigger and the dropdown —
              a portalled dropdown still bubbles through the React tree, so without
              it managing folders would double as "switch to this tab". */}
          <Menu position="bottom-start" width="min(320px, calc(100vw - 2rem))" withinPortal>
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                size={14}
                aria-label="Project folders"
                onClick={(e) => e.stopPropagation()}
              >
                <IconDots size={12} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
              {isLocal && (
                <Menu.Item leftSection={<IconFolderPlus size={14} />} onClick={addFolder}>
                  Add folder…
                </Menu.Item>
              )}
              {/* Only the extra roots are listed: the primary is the project's
                  identity and can't be removed, only closed. */}
              {extraRoots.length > 0 && <Menu.Label>Extra folders</Menu.Label>}
              {extraRoots.map((root) => (
                // Each row is a named action, not a bare path that happens to be
                // destructive. A CloseButton in rightSection would nest a <button>
                // inside Menu.Item's own <button> — invalid markup, and the click
                // lands on one or the other depending on the exact pixel.
                <Menu.Item
                  key={root}
                  color="red"
                  leftSection={<IconFolderMinus size={14} />}
                  onClick={() => setPendingRemove(root)}
                >
                  <Text size="xs">
                    Remove{' '}
                    {/* truncate="start" keeps the tail: the distinctive part of a path. */}
                    <Text span ff="monospace" truncate="start">
                      {root}
                    </Text>
                  </Text>
                </Menu.Item>
              ))}
              <Menu.Divider />
              {/* Worktrees are a separate section from the folders above on purpose:
                  they are attributed to this tab without widening what its sessions
                  may write to. */}
              <Menu.Item
                leftSection={<IconGitBranch size={14} />}
                onClick={() => setWorktreeModal({ target: null })}
              >
                New worktree…
              </Menu.Item>
              {worktrees.length > 0 && <Menu.Label>Worktrees</Menu.Label>}
              {worktrees.map((w) => (
                <Menu.Item
                  key={w.path}
                  leftSection={<IconGitBranch size={14} />}
                  onClick={() => setWorktreeModal({ target: w.path })}
                >
                  <Text size="xs" truncate>
                    {worktreeLabel(w).title}
                    {worktreeLabel(w).hint && (
                      <Text span c="dimmed">
                        {' '}
                        · {worktreeLabel(w).hint}
                      </Text>
                    )}
                  </Text>
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          <CloseButton
            size={14}
            onClick={(e) => {
              e.stopPropagation();
              send({ type: 'closeProject', path });
            }}
          />
        </Box>
      </Tooltip>
      {/* Outside the tab's Box on purpose: a click inside the modal would otherwise
          bubble up to the Box's onClick and switch projects behind the dialog. */}
      <ConfirmModal
        opened={pendingRemove !== null}
        title="Remove folder"
        message={`Remove ${pendingRemove ?? ''} from this project? Sessions in this tab lose access to it — nothing on disk is deleted.`}
        confirmLabel="Remove"
        confirmColor="red"
        onConfirm={() => {
          send({ type: 'removeProjectRoot', project: path, path: pendingRemove! });
          setPendingRemove(null);
        }}
        onCancel={() => setPendingRemove(null)}
      />
      {/* Outside the tab's Box for the same reason as the ConfirmModal above. */}
      {worktreeModal && (
        <WorktreeModal
          project={project}
          target={worktreeModal.target}
          onClose={() => setWorktreeModal(null)}
        />
      )}
    </>
  );
}

export function ProjectTabs() {
  const projects = useStore((s) => s.projects);
  const activeProject = useStore((s) => s.activeProject);
  const recentDirs = useStore((s) => s.recentDirs);
  const folderPickPending = useStore((s) => s.folderPickPending);
  const setFolderPickPending = useStore((s) => s.setFolderPickPending);
  const setFolderPickTarget = useStore((s) => s.setFolderPickTarget);
  // Finder opens on the host, so Browse… is hidden off-machine. The recents
  // below stay: they are exactly the projects a remote device can reach.
  const isLocal = useIsLocalMachine();

  const browse = () => {
    setFolderPickTarget(null); // a plain browse opens a project rather than widening one
    setFolderPickPending(true);
    send({ type: 'pickFolder' });
  };
  const openRecent = (dir: string) => {
    send({ type: 'openProject', path: dir });
    useStore.getState().setActiveProject(dir);
  };
  const recents = recentDirs.filter((d) => !projects.some((p) => p.path === d)).slice(0, 8);

  return (
    <Group h="100%" px="sm" gap="sm" wrap="nowrap">
      {/* Connection state lives in ConnectionBanner (a centered pill for every
          non-connected state), so a dot here would only ever say "fine". */}
      <Box ml={4} mr={4} display="flex">
        <BrandMark />
      </Box>
      <Box className="brand-separator" mx={8} />
      <ScrollArea type="never" style={{ flex: 1 }}>
        <Group gap={4} wrap="nowrap">
          {projects.map((p) => (
            <ProjectTab key={p.path} project={p} active={p.path === activeProject} />
          ))}
          <Menu position="bottom-start" width="min(320px, calc(100vw - 2rem))">
            <Menu.Target>
              <Tooltip label="Open project">
                <ActionIcon variant="subtle" color="gray" size="sm" disabled={folderPickPending}>
                  {folderPickPending ? <Loader size={12} /> : <IconPlus size={14} />}
                </ActionIcon>
              </Tooltip>
            </Menu.Target>
            <Menu.Dropdown>
              {isLocal && (
                <Menu.Item leftSection={<IconFolderOpen size={14} />} onClick={browse}>
                  Browse…
                </Menu.Item>
              )}
              {recents.length > 0 && <Menu.Label>Recent</Menu.Label>}
              {recents.map((d) => (
                <Menu.Item key={d} onClick={() => openRecent(d)}>
                  <Text size="xs" truncate ff="monospace">
                    {d}
                  </Text>
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        </Group>
      </ScrollArea>
      <UsageIndicator />
      <DocsButton />
      <ThemeToggle />
      <SettingsButton />
      <UserMenu />
    </Group>
  );
}

/** Direct route into the documentation reader; Settings carries the same entry point. */
function DocsButton() {
  const navigate = useNavigate();
  const activeProject = useStore((s) => s.activeProject);
  const onDocs = useLocation().pathname.startsWith('/docs');
  return (
    <Tooltip label={activeProject ? 'Documentation' : 'Open a project to read its docs'}>
      <ActionIcon
        variant={onDocs ? 'light' : 'subtle'}
        color="gray"
        size="sm"
        aria-label="Documentation"
        disabled={!activeProject}
        onClick={() => navigate('/docs')}
      >
        <IconBooks size={14} />
      </ActionIcon>
    </Tooltip>
  );
}

function SettingsButton() {
  const [opened, setOpened] = useState(false);
  // A dismissed allowlist review still needs a way back in; the gear is it.
  const guardReview = useStore((s) => s.guardReview);
  const guest = useIsGuest();
  // A phone that scanned the machine's QR arrives at `/?enroll=…`. Opening the
  // pane for them is the whole point of the QR — a code they have to go hunting
  // for a settings pane to use is a code they will type by hand instead.
  const enrolling = new URLSearchParams(window.location.search).has('enroll');
  useEffect(() => {
    if (enrolling) setOpened(true);
  }, [enrolling]);
  return (
    <>
      <Tooltip label={guardReview ? 'Settings — allowlist needs review' : 'Settings'}>
        <Indicator size={6} color="yellow" disabled={!guardReview} offset={2}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label="Settings"
            onClick={() => setOpened(true)}
          >
            <IconSettings size={14} />
          </ActionIcon>
        </Indicator>
      </Tooltip>
      <SettingsModal
        opened={opened}
        onClose={() => setOpened(false)}
        // A guest lands on Machines, the one pane that is theirs rather than the
        // host's — and their only way back to their own machine. Hiding the gear
        // outright would strand them on somebody else's computer.
        initialSection={
          enrolling ? 'encryption' : guest ? 'devices' : guardReview ? 'allowlist' : 'account'
        }
      />
    </>
  );
}

function ThemeToggle() {
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const dark = colorScheme === 'dark';
  return (
    <Tooltip label={dark ? 'Light mode' : 'Dark mode'}>
      <ActionIcon variant="subtle" color="gray" size="sm" onClick={toggleColorScheme}>
        {dark ? <IconSun size={14} /> : <IconMoon size={14} />}
      </ActionIcon>
    </Tooltip>
  );
}
