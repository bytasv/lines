import { Alert, ActionIcon, Box, Center, Group, Loader, Stack, Text, UnstyledButton } from '@mantine/core';
import { useComputedColorScheme } from '@mantine/core';
import { IconFiles, IconX } from '@tabler/icons-react';
import { Editor } from '@monaco-editor/react';
import { useStore } from '../store';
import { useIsPhone } from '../lib/layout';
import { BestOnDesktop } from './BestOnDesktop';
import { useFileContent } from '../lib/files';
import { languageFor } from '../lib/language';

function FileTab({ path, project, active }: { path: string; project: string; active: boolean }) {
  const setActiveFileTab = useStore((s) => s.setActiveFileTab);
  const closeFileTab = useStore((s) => s.closeFileTab);
  const name = path.split('/').pop() ?? path;
  const rel = path.startsWith(project + '/') ? path.slice(project.length + 1) : path;

  return (
    <UnstyledButton
      onClick={() => setActiveFileTab(path)}
      px={8}
      py={4}
      style={{
        borderRadius: 6,
        background: active ? 'var(--mantine-color-default-hover)' : undefined,
        flexShrink: 0,
      }}
      title={rel}
    >
      <Group gap={4} wrap="nowrap">
        <Text size="xs" ff="monospace" fw={active ? 600 : 400}>
          {name}
        </Text>
        <ActionIcon
          component="span"
          size={14}
          variant="subtle"
          color="gray"
          onClick={(e) => {
            e.stopPropagation();
            closeFileTab(path);
          }}
        >
          <IconX size={11} />
        </ActionIcon>
      </Group>
    </UnstyledButton>
  );
}

function FileEditor({ path }: { path: string }) {
  const colorScheme = useComputedColorScheme('dark');
  const { content, error } = useFileContent(path);

  if (error) {
    return (
      <Alert color="red" m="xs">
        {error}
      </Alert>
    );
  }
  if (content === null) {
    return (
      <Center h="100%">
        <Loader />
      </Center>
    );
  }
  return (
    <Editor
      height="100%"
      language={languageFor(path)}
      value={content}
      theme={colorScheme === 'dark' ? 'vs-dark' : 'light'}
      options={{
        readOnly: true,
        minimap: { enabled: false },
        fontSize: 12,
        scrollBeyondLastLine: false,
        automaticLayout: true,
      }}
    />
  );
}

/** Main-pane files mode: tab bar of opened files + read-only Monaco editor. */
export function FilesView() {
  const activeProject = useStore((s) => s.activeProject);
  const openFiles = useStore((s) => activeProject ? s.openFiles[activeProject] : undefined);
  const isPhone = useIsPhone();

  const empty = (
    <Center h="100%">
      <Stack align="center" gap="xs">
        <IconFiles size={48} stroke={1.2} opacity={0.4} />
        <Text size="sm" c="dimmed">
          Pick a file from the tree in the sidebar
        </Text>
      </Stack>
    </Center>
  );

  // Monaco on a 390px screen is a text field you cannot navigate: no gutter
  // room, no keyboard shortcuts, and a virtual keyboard over half the viewport.
  // Said plainly rather than shipped shrunk.
  if (isPhone) return <BestOnDesktop what="Browsing files" />;

  if (!activeProject || !openFiles || openFiles.tabs.length === 0) return empty;

  return (
    <Stack gap={0} h="100%">
      <Group gap={4} px="xs" py={6} wrap="nowrap" style={{ overflowX: 'auto' }}>
        {openFiles.tabs.map((path) => (
          <FileTab
            key={path}
            path={path}
            project={activeProject}
            active={path === openFiles.active}
          />
        ))}
      </Group>
      <Box style={{ flex: 1, minHeight: 0 }}>
        {openFiles.active ? <FileEditor key={openFiles.active} path={openFiles.active} /> : empty}
      </Box>
    </Stack>
  );
}
