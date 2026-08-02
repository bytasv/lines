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
  IconMoon,
  IconPlus,
  IconSettings,
  IconSun,
} from '@tabler/icons-react';
import { useState, type CSSProperties } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Project } from '@lines/shared';
import { projectRoots } from '@lines/shared';
import { ConfirmModal } from './ConfirmModal';
import { projectStatusMeta } from '../lib/format';
import { sessionsInProject, useStore } from '../store';
import { send } from '../ws';
import logoUrl from '../assets/logo-mark.png';
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
  // The active project's sessions are already spelled out in the sidebar, so a
  // dot here would only be noise. Leaving keeps it quiet: opening the project
  // marked those states seen, and only a state the user hasn't seen re-lights it.
  const status = active
    ? null
    : projectStatusMeta(sessionsInProject(sessions, projectKeys, project), seen);
  // The label stays the primary's basename; the tooltip is where every root fits.
  const rootList = projectRoots(project).join('\n');

  const addFolder = () => {
    setFolderPickTarget(path);
    setFolderPickPending(true);
    send({ type: 'pickFolder' });
  };

  // The root awaiting confirmation. Removal widens/narrows what every session in
  // this tab may write to, so it goes through the same gate as deleting a step.
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

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
          <Menu position="bottom-start" width={320} withinPortal>
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
              <Menu.Item leftSection={<IconFolderPlus size={14} />} onClick={addFolder}>
                Add folder…
              </Menu.Item>
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
      {/* The brand is the mark alone — there is no sibling <Text>, so alt carries
          the accessible name. The art is near-black on transparent and would
          vanish into the dark header, so the plate supplies the white ground and
          the rounded corners the PNG no longer bakes in.
          Connection state lives in ConnectionBanner (a centered pill for every
          non-connected state), so a dot here would only ever say "fine". */}
      <Box
        ml={4}
        mr={4}
        style={{
          background: '#ffffff',
          borderRadius: 6,
          padding: 4,
          display: 'flex',
          boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
        }}
      >
        <img src={logoUrl} alt="Lines" height={24} style={{ display: 'block', width: 'auto' }} />
      </Box>
      <Box className="brand-separator" mx={8} />
      <ScrollArea type="never" style={{ flex: 1 }}>
        <Group gap={4} wrap="nowrap">
          {projects.map((p) => (
            <ProjectTab key={p.path} project={p} active={p.path === activeProject} />
          ))}
          <Menu position="bottom-start" width={320}>
            <Menu.Target>
              <Tooltip label="Open project">
                <ActionIcon variant="subtle" color="gray" size="sm" disabled={folderPickPending}>
                  {folderPickPending ? <Loader size={12} /> : <IconPlus size={14} />}
                </ActionIcon>
              </Tooltip>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconFolderOpen size={14} />} onClick={browse}>
                Browse…
              </Menu.Item>
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
        initialSection={guardReview ? 'allowlist' : 'account'}
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
