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
import { IconFolder, IconFolderOpen, IconMoon, IconPlus, IconSettings, IconSun } from '@tabler/icons-react';
import { useState, type CSSProperties } from 'react';
import { projectStatusMeta } from '../lib/format';
import { sessionsInProject, useStore } from '../store';
import { send } from '../ws';
import logoUrl from '../assets/logo.svg';
import { SettingsModal } from './SettingsModal';
import { UsageIndicator } from './UsageIndicator';
import { UserMenu } from './UserMenu';

function baseName(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function ProjectTab({ path, active }: { path: string; active: boolean }) {
  const setActiveProject = useStore((s) => s.setActiveProject);
  const sessions = useStore((s) => s.sessions);
  const projectKeys = useStore((s) => s.projectKeys);
  const seen = useStore((s) => s.seenSessionStatus);
  // The active project's sessions are already spelled out in the sidebar, so a
  // dot here would only be noise. Leaving keeps it quiet: opening the project
  // marked those states seen, and only a state the user hasn't seen re-lights it.
  const status = active
    ? null
    : projectStatusMeta(sessionsInProject(sessions, projectKeys, path), seen);

  return (
    <Tooltip label={status ? `${path} — ${status.label}` : path} openDelay={500}>
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
          ) : (
            <IconFolder size={13} opacity={0.6} />
          )}
        </Center>
        <Text size="xs" fw={active ? 600 : 400}>
          {baseName(path)}
        </Text>
        <CloseButton
          size={14}
          onClick={(e) => {
            e.stopPropagation();
            send({ type: 'closeProject', path });
          }}
        />
      </Box>
    </Tooltip>
  );
}

export function ProjectTabs() {
  const projects = useStore((s) => s.projects);
  const activeProject = useStore((s) => s.activeProject);
  const recentDirs = useStore((s) => s.recentDirs);
  const folderPickPending = useStore((s) => s.folderPickPending);
  const setFolderPickPending = useStore((s) => s.setFolderPickPending);

  const browse = () => {
    setFolderPickPending(true);
    send({ type: 'pickFolder' });
  };
  const openRecent = (dir: string) => {
    send({ type: 'openProject', path: dir });
    useStore.getState().setActiveProject(dir);
  };
  const recents = recentDirs.filter((d) => !projects.includes(d)).slice(0, 8);

  return (
    <Group h="100%" px="sm" gap="sm" wrap="nowrap">
      <Group gap={6} wrap="nowrap">
        <Box
          ml={4}
          mr={4}
          style={{
            background: '#ffffff',
            borderRadius: 9,
            padding: 6,
            display: 'flex',
            boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
          }}
        >
          <img src={logoUrl} alt="Lines" width={20} height={20} style={{ display: 'block' }} />
        </Box>
        {/* Connection state lives in ConnectionBanner (a centered pill for every
            non-connected state), so a dot here would only ever say "fine". */}
        <Text component="span" className="brand-wordmark" fw={300} size="md">
          Lines
        </Text>
      </Group>
      <Box className="brand-separator" mx={8} />
      <ScrollArea type="never" style={{ flex: 1 }}>
        <Group gap={4} wrap="nowrap">
          {projects.map((p) => (
            <ProjectTab key={p} path={p} active={p === activeProject} />
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
      <ThemeToggle />
      <SettingsButton />
      <UserMenu />
    </Group>
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
