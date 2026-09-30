import { useEffect, useState } from 'react';
import { Alert, ActionIcon, Box, Center, Group, Loader, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useComputedColorScheme } from '@mantine/core';
import { IconFiles, IconX } from '@tabler/icons-react';
import { Editor, type OnMount } from '@monaco-editor/react';
// See MonacoPreviewModal: every module that mounts an editor owns this import,
// and React.lazy is what keeps it out of the entry chunk.
import '../lib/monacoSetup';
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

type MonacoEditor = Parameters<OnMount>[0];

function FileEditor({ path, line, col }: { path: string; line?: number; col?: number }) {
  const colorScheme = useComputedColorScheme('dark');
  const { content, error } = useFileContent(path);
  const [editor, setEditor] = useState<MonacoEditor | null>(null);

  // Re-run on every line change, not only on mount: the search preview keeps one
  // editor per file and moves it between that file's hits.
  useEffect(() => {
    if (!editor || !line) return;
    const model = editor.getModel();
    if (!model || line > model.getLineCount()) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: col ?? 1 });
    editor.setSelection({
      startLineNumber: line,
      startColumn: 1,
      endLineNumber: line,
      endColumn: model.getLineMaxColumn(line),
    });
  }, [editor, line, col]);

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
      onMount={(mounted) => setEditor(mounted)}
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

/**
 * A file-search hit, open in the main pane while the results stay in the
 * sidebar — the files mode would swap the sidebar for its tree and lose them.
 */
export function SearchPreviewView() {
  const preview = useStore((s) => s.searchPreview);
  const activeProject = useStore((s) => s.activeProject);
  const setSearchPreview = useStore((s) => s.setSearchPreview);
  const isPhone = useIsPhone();
  if (!preview) return null;
  if (isPhone) return <BestOnDesktop what="Reading source" onClose={() => setSearchPreview(null)} />;
  const rel =
    activeProject && preview.path.startsWith(activeProject + '/')
      ? preview.path.slice(activeProject.length + 1)
      : preview.path;
  return (
    <Stack gap={0} h="100%">
      <Group gap={6} px="xs" py={6} wrap="nowrap" justify="space-between">
        <Text size="xs" ff="monospace" fw={600} truncate title={preview.path}>
          {rel}
          {preview.line ? `:${preview.line}` : ''}
        </Text>
        <Tooltip label="Close preview">
          <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => setSearchPreview(null)}>
            <IconX size={13} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Box style={{ flex: 1, minHeight: 0 }}>
        <FileEditor key={preview.path} path={preview.path} line={preview.line} col={preview.col} />
      </Box>
    </Stack>
  );
}
