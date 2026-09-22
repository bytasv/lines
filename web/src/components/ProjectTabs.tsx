import {
  ActionIcon,
  Box,
  Button,
  Drawer,
  Stack,
  TextInput,
  UnstyledButton,
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
  IconChevronDown,
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
import { useIsPhone } from '../lib/layout';
import { sessionsOnMachine } from '../lib/machines';
import { send } from '../ws';
import { BrandMark } from './BrandMark';
import { MachineSwitcher } from './MachineSwitcher';
import { SettingsModal } from './SettingsModal';
import { UsageIndicator } from './UsageIndicator';
import { UserMenu } from './UserMenu';

function baseName(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function ProjectTab({
  project,
  active,
  mobile = false,
  onSelect,
  onRemoveRoot,
  onWorktree,
}: {
  project: Project;
  active: boolean;
  mobile?: boolean;
  onSelect?: () => void;
  onRemoveRoot: (project: Project, root: string) => void;
  onWorktree: (project: Project, target: string | null) => void;
}) {
  const path = project.path;
  const extraRoots = project.extraRoots ?? [];
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setFolderPickPending = useStore((s) => s.setFolderPickPending);
  const setFolderPickTarget = useStore((s) => s.setFolderPickTarget);
  const sessions = useStore((s) => s.sessions);
  const sessionMachine = useStore((s) => s.sessionMachine);
  const primaryDeviceId = useStore((s) => s.primaryDeviceId);
  const projectKeys = useStore((s) => s.projectKeys);
  const seen = useStore((s) => s.seenSessionStatus);
  // "Add folder…" shells out to Finder on the host, so it exists only for a
  // browser on the host. A remote device widens a project from the typed path.
  const isLocal = useIsLocalMachine();
  // The active project's sessions are already spelled out in the sidebar, so a
  // dot here would only be noise. Leaving keeps it quiet: opening the project
  // marked those states seen, and only a state the user hasn't seen re-lights it.
  // Scoped to the machine in front of the user, exactly as the sidebar's list is:
  // a tab that pulses for a session that list does not show has nothing to open.
  const status = active
    ? null
    : projectStatusMeta(
        sessionsInProject(
          sessionsOnMachine(sessions, sessionMachine, primaryDeviceId ?? ''),
          projectKeys,
          project,
        ),
        seen,
      );
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
          onClick={mobile ? undefined : () => setActiveProject(path)}
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
          {mobile ? (
            <UnstyledButton
              style={{ flex: 1, minWidth: 0 }}
              py={6}
              aria-current={active ? 'true' : undefined}
              onClick={() => {
                setActiveProject(path);
                onSelect?.();
              }}
            >
              <Text size="sm" fw={active ? 600 : 400} truncate>
                {baseName(path)}
              </Text>
              <Text size="xs" c="dimmed" truncate>
                {path}
              </Text>
              {status && (
                <Text size="xs" c={status.color}>
                  {status.label}
                </Text>
              )}
            </UnstyledButton>
          ) : (
            <Text size="xs" fw={active ? 600 : 400}>
              {baseName(path)}
            </Text>
          )}
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
              {mobile && (
                <Menu.Item onClick={() => send({ type: 'closeProject', path })}>
                  Close project
                </Menu.Item>
              )}
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
                  onClick={() => onRemoveRoot(project, root)}
                >
                  <Text size="xs">
                    Remove {/* truncate="start" keeps the tail: the distinctive part of a path. */}
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
                onClick={() => onWorktree(project, null)}
              >
                New worktree…
              </Menu.Item>
              {worktrees.length > 0 && <Menu.Label>Worktrees</Menu.Label>}
              {worktrees.map((w) => (
                <Menu.Item
                  key={w.path}
                  leftSection={<IconGitBranch size={14} />}
                  onClick={() => onWorktree(project, w.path)}
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
          {!mobile && (
            <CloseButton
              aria-label={`Close ${baseName(path)}`}
              size={14}
              onClick={(e) => {
                e.stopPropagation();
                send({ type: 'closeProject', path });
              }}
            />
          )}
        </Box>
      </Tooltip>
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
  const isPhone = useIsPhone();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [pendingRemove, setPendingRemove] = useState<{ project: Project; root: string } | null>(
    null,
  );
  const [worktreeModal, setWorktreeModal] = useState<{
    project: Project;
    target: string | null;
  } | null>(null);
  const projectActions = {
    onRemoveRoot: (project: Project, root: string) => {
      setPickerOpen(false);
      setPendingRemove({ project, root });
    },
    onWorktree: (project: Project, target: string | null) => {
      setPickerOpen(false);
      setWorktreeModal({ project, target });
    },
  };

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
    <Group h="100%" px={isPhone ? 'xs' : 'sm'} gap={isPhone ? 'xs' : 'sm'} wrap="nowrap">
      {/* Connection state lives in ConnectionBanner (a centered pill for every
          non-connected state), so a dot here would only ever say "fine".

          Dropped on a phone along with its separator: it is the one thing in
          this row that does nothing, and the ~110px it costs is the difference
          between the project tabs being readable and being a sliver. The burger
          already anchors the left edge. */}
      {!isPhone && (
        <>
          <Box ml={4} mr={4} display="flex">
            <BrandMark />
          </Box>
          {/* Where the brand/tabs separator used to sit. A machine is the one
              thing the header never said, and switching was buried two clicks
              deep in Settings — so the punctuation earns its place instead.
              Icon-only: a name here would eat the tab strip. */}
          <MachineSwitcher />
        </>
      )}
      {isPhone ? (
        <>
          <Button
            variant="subtle"
            color="gray"
            px={6}
            rightSection={<IconChevronDown size={16} />}
            style={{ flex: 1, minWidth: 0 }}
            styles={{
              label: {
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            }}
            aria-label="Switch project"
            onClick={() => {
              setProjectSearch('');
              setPickerOpen(true);
            }}
          >
            <Text component="span" size="sm" truncate>
              {activeProject ? baseName(activeProject) : 'Projects'}
            </Text>
          </Button>
          <Drawer
            opened={pickerOpen}
            onClose={() => setPickerOpen(false)}
            position="bottom"
            size="min(80dvh, var(--lines-viewport))"
            title="Projects"
            keepMounted
            classNames={{ content: 'lines-mobile-sheet', inner: 'lines-mobile-sheet-inner' }}
          >
            <Stack gap="sm" className="lines-safe-bottom">
              {/* The header has no room for the switcher on a phone — the brand
                  and its separator are dropped there for the same reason — so the
                  machine lives at the top of this sheet, above the projects it
                  scopes. */}
              <MachineSwitcher variant="row" onSwitch={() => setPickerOpen(false)} />
              <TextInput
                label="Search projects"
                placeholder="Name or path"
                value={projectSearch}
                onChange={(event) => setProjectSearch(event.currentTarget.value)}
              />
              {projects.map((project) => (
                <Box
                  key={project.path}
                  display={
                    project.path.toLowerCase().includes(projectSearch.toLowerCase())
                      ? undefined
                      : 'none'
                  }
                >
                  <ProjectTab
                    {...projectActions}
                    project={project}
                    active={project.path === activeProject}
                    mobile
                    onSelect={() => setPickerOpen(false)}
                  />
                </Box>
              ))}
              {!projects.some((project) =>
                project.path.toLowerCase().includes(projectSearch.toLowerCase()),
              ) && (
                <Text size="sm" c="dimmed">
                  {projects.length ? 'No matching projects.' : 'No open projects.'}
                </Text>
              )}
              {isLocal && (
                <Button variant="light" disabled={folderPickPending} onClick={browse}>
                  Open project…
                </Button>
              )}
              {recents.length > 0 && (
                <Text size="sm" fw={500}>
                  Recent projects
                </Text>
              )}
              {recents
                .filter((path) => path.toLowerCase().includes(projectSearch.toLowerCase()))
                .map((path) => (
                  <UnstyledButton
                    key={path}
                    py={8}
                    onClick={() => {
                      openRecent(path);
                      setPickerOpen(false);
                    }}
                  >
                    <Text size="sm" truncate>
                      {baseName(path)}
                    </Text>
                    <Text size="xs" c="dimmed" truncate>
                      {path}
                    </Text>
                  </UnstyledButton>
                ))}
            </Stack>
          </Drawer>
        </>
      ) : (
        <ScrollArea type="never" style={{ flex: 1 }}>
          <Group gap={4} wrap="nowrap">
            {projects.map((p) => (
              <ProjectTab
                {...projectActions}
                key={p.path}
                project={p}
                active={p.path === activeProject}
              />
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
      )}
      <UsageIndicator />
      <HeaderActions />
      <UserMenu />
      <ConfirmModal
        opened={pendingRemove !== null}
        title="Remove folder"
        message={`Remove ${pendingRemove?.root ?? ''} from this project? Sessions in this tab lose access to it — nothing on disk is deleted.`}
        confirmLabel="Remove"
        confirmColor="red"
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          if (pendingRemove)
            send({
              type: 'removeProjectRoot',
              project: pendingRemove.project.path,
              path: pendingRemove.root,
            });
          setPendingRemove(null);
        }}
      />
      {worktreeModal && (
        <WorktreeModal
          project={worktreeModal.project}
          target={worktreeModal.target}
          onClose={() => setWorktreeModal(null)}
        />
      )}
    </Group>
  );
}

/**
 * The header's trailing controls: documentation, theme, settings.
 *
 * One component rather than three because of the phone branch. At 390px the row
 * does not fit beside the project tabs — the burger, the brand, the tabs and
 * five controls add up past the viewport, and the tabs are what gets squeezed
 * out — so on a phone they fold into one overflow menu. Same handlers, one
 * decision path.
 *
 * The settings modal has to be mounted *outside* that menu: rendered inside the
 * dropdown, choosing "Settings" closes the menu, which unmounts the dropdown
 * and takes the modal with it.
 */
function HeaderActions() {
  const isPhone = useIsPhone();
  const navigate = useNavigate();
  const activeProject = useStore((s) => s.activeProject);
  const onDocs = useLocation().pathname.startsWith('/docs');
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const dark = colorScheme === 'dark';
  const [settingsOpen, setSettingsOpen] = useState(false);
  // A dismissed allowlist review still needs a way back in; the gear is it.
  const guardReview = useStore((s) => s.guardReview);
  const guest = useIsGuest();
  // A phone that scanned the machine's QR arrives carrying a code. Opening the
  // pane for them is the whole point of the QR — a code they have to go hunting
  // for a settings pane to use is a code they will type by hand instead.
  //
  // Both forms: the code moved into the fragment (a query string is sent to the
  // server, which is the one party it must not reach), but a QR printed by an
  // older desktop build still uses the query.
  const enrolling =
    new URLSearchParams(window.location.search).has('enroll') ||
    new URLSearchParams(window.location.hash.replace(/^#/, '')).has('enroll');
  useEffect(() => {
    if (enrolling) setSettingsOpen(true);
  }, [enrolling]);

  const openDocs = () => navigate('/docs');
  const themeLabel = dark ? 'Light mode' : 'Dark mode';

  return (
    <>
      {isPhone ? (
        // The dot rides the whole menu, since the gear it belongs to is inside.
        <Indicator size={6} color="yellow" disabled={!guardReview} offset={4}>
          <Menu position="bottom-end" width={220} withinPortal>
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="More"
              >
                <IconDots size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconBooks size={14} />}
                disabled={!activeProject}
                onClick={openDocs}
              >
                Documentation
              </Menu.Item>
              <Menu.Item
                leftSection={dark ? <IconSun size={14} /> : <IconMoon size={14} />}
                onClick={toggleColorScheme}
              >
                {themeLabel}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconSettings size={14} />}
                onClick={() => setSettingsOpen(true)}
              >
                {guardReview ? 'Settings — allowlist needs review' : 'Settings'}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Indicator>
      ) : (
        <>
          <Tooltip label={activeProject ? 'Documentation' : 'Open a project to read its docs'}>
            <ActionIcon
              variant={onDocs ? 'light' : 'subtle'}
              color="gray"
              size="sm"
              aria-label="Documentation"
              disabled={!activeProject}
              onClick={openDocs}
            >
              <IconBooks size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={themeLabel}>
            <ActionIcon variant="subtle" color="gray" size="sm" onClick={toggleColorScheme}>
              {dark ? <IconSun size={14} /> : <IconMoon size={14} />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label={guardReview ? 'Settings — allowlist needs review' : 'Settings'}>
            <Indicator size={6} color="yellow" disabled={!guardReview} offset={2}>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Settings"
                onClick={() => setSettingsOpen(true)}
              >
                <IconSettings size={14} />
              </ActionIcon>
            </Indicator>
          </Tooltip>
        </>
      )}
      <SettingsModal
        opened={settingsOpen}
        onClose={() => setSettingsOpen(false)}
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
