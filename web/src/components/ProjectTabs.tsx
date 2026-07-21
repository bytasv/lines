import {
  ActionIcon,
  Box,
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
import { useState } from 'react';
import { useStore } from '../store';
import { send } from '../ws';
import logoUrl from '../assets/logo.svg';
import { SettingsModal } from './SettingsModal';
import { UsageIndicator } from './UsageIndicator';

function baseName(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function ProjectTab({ path, active }: { path: string; active: boolean }) {
  const setActiveProject = useStore((s) => s.setActiveProject);

  return (
    <Tooltip label={path} openDelay={500}>
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
        <IconFolder size={13} opacity={0.6} />
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
  const connected = useStore((s) => s.connected);
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
        <Text fw={700} size="sm">
          Lines
        </Text>
        <Indicator color={connected ? 'teal' : 'red'} size={7} />
      </Group>
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
    </Group>
  );
}

function SettingsButton() {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <Tooltip label="Settings">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label="Settings"
          onClick={() => setOpened(true)}
        >
          <IconSettings size={14} />
        </ActionIcon>
      </Tooltip>
      <SettingsModal opened={opened} onClose={() => setOpened(false)} />
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
