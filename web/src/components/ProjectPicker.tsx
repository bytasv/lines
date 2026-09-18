import { useState } from 'react';
import {
  ActionIcon,
  Button,
  Center,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconArrowRight, IconFolderOpen, IconFolders } from '@tabler/icons-react';
import { useStore } from '../store';
import { useIsLocalMachine } from '../lib/can';
import { send } from '../ws';

export function ProjectPicker() {
  const recentDirs = useStore((s) => s.recentDirs);
  // Browse… opens Finder on the machine running the bridge, so it is offered
  // only to a browser on that machine. Elsewhere the typed path and the recents
  // below are the whole story.
  const isLocal = useIsLocalMachine();
  const folderPickPending = useStore((s) => s.folderPickPending);
  const setFolderPickPending = useStore((s) => s.setFolderPickPending);
  const [manualPath, setManualPath] = useState('');

  const open = (dir: string) => {
    send({ type: 'openProject', path: dir });
    useStore.getState().setActiveProject(dir);
  };
  const browse = () => {
    setFolderPickPending(true);
    send({ type: 'pickFolder' });
  };
  const openManual = () => {
    const dir = manualPath.trim();
    if (dir) open(dir);
  };

  return (
    <Center h="100%">
      {/* A phone is narrower than this was: cap against the viewport rather
          than fixing it, so the picker is usable at 390px. */}
      <Stack align="center" gap="md" w="100%" maw={420} px="md">
        <IconFolders size={48} stroke={1.2} opacity={0.4} />
        <Title order={3}>Open a project</Title>
        <Text size="sm" c="dimmed" ta="center">
          Pick a folder to work in — sessions run in its context.
        </Text>
        {isLocal && (
          <Button
            leftSection={folderPickPending ? <Loader size={14} /> : <IconFolderOpen size={16} />}
            disabled={folderPickPending}
            onClick={browse}
          >
            Browse…
          </Button>
        )}
        <Group gap="xs" w="100%" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            size="xs"
            placeholder="/path/to/project"
            value={manualPath}
            onChange={(e) => setManualPath(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && openManual()}
          />
          <ActionIcon variant="default" size={30} onClick={openManual} disabled={!manualPath.trim()}>
            <IconArrowRight size={14} />
          </ActionIcon>
        </Group>
        {recentDirs.length > 0 && (
          <>
            <Divider label="Recent" w="100%" />
            <Stack gap={2} w="100%">
              {recentDirs.slice(0, 8).map((d) => (
                <Button
                  key={d}
                  variant="subtle"
                  color="gray"
                  size="compact-sm"
                  justify="flex-start"
                  fullWidth
                  onClick={() => open(d)}
                >
                  <Text size="xs" ff="monospace" truncate>
                    {d}
                  </Text>
                </Button>
              ))}
            </Stack>
          </>
        )}
      </Stack>
    </Center>
  );
}
