import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  ActionIcon,
  Box,
  Center,
  Group,
  Loader,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useComputedColorScheme } from '@mantine/core';
import { IconCode, IconEye, IconFiles, IconX } from '@tabler/icons-react';
import { Editor, type OnMount } from '@monaco-editor/react';
// See MonacoPreviewModal: every module that mounts an editor owns this import,
// and React.lazy is what keeps it out of the entry chunk.
import '../lib/monacoSetup';
import { docDirname, normalizeDocPath } from '@lines/shared';
import { useStore } from '../store';
import { useIsPhone } from '../lib/layout';
import { BestOnDesktop } from './BestOnDesktop';
import { useFileContent } from '../lib/files';
import { isMarkdownPath, languageFor } from '../lib/language';
import { Markdown } from './Markdown';

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

function MonacoView({ path, content, line, col }: { path: string; content: string; line?: number; col?: number }) {
  const colorScheme = useComputedColorScheme('dark');
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

export type MarkdownMode = 'preview' | 'raw';

/**
 * Preview/Raw state for the file a header shows, or `null` for a non-markdown
 * file (no toggle). Markdown opens rendered unless the caller asks for source
 * (`forceRaw`) or points at a line — a line only means something in the source.
 * The choice is not persisted: it resets whenever `openKey` changes, so every
 * open starts in its default mode.
 */
export function useMarkdownMode(
  path: string | undefined,
  { line, forceRaw, openKey = path }: { line?: number; forceRaw?: boolean; openKey?: unknown } = {},
): [MarkdownMode, (mode: MarkdownMode) => void] | null {
  const [chosen, setChosen] = useState<{ key: unknown; mode: MarkdownMode } | null>(null);
  if (chosen && chosen.key !== openKey) setChosen(null);
  if (!path || !isMarkdownPath(path)) return null;
  const mode = chosen && chosen.key === openKey ? chosen.mode : !line && !forceRaw ? 'preview' : 'raw';
  return [mode, (next) => setChosen({ key: openKey, mode: next })];
}

function ModeLabel({ icon: Icon, label }: { icon: typeof IconEye; label: string }) {
  return (
    <Group gap={4} wrap="nowrap">
      <Icon size={13} />
      <span>{label}</span>
    </Group>
  );
}

/** The header control for `useMarkdownMode`; renders nothing for non-markdown files. */
export function MarkdownModeToggle({ state }: { state: ReturnType<typeof useMarkdownMode> }) {
  if (!state) return null;
  const [mode, setMode] = state;
  return (
    <SegmentedControl
      size="xs"
      value={mode}
      onChange={(v) => setMode(v as MarkdownMode)}
      data={[
        { value: 'preview', label: <ModeLabel icon={IconEye} label="Preview" /> },
        { value: 'raw', label: <ModeLabel icon={IconCode} label="Raw" /> },
      ]}
    />
  );
}

/**
 * A workspace file, read-only: rendered markdown when `mode` is `'preview'`,
 * Monaco otherwise. The mode comes from the host's header (`useMarkdownMode`).
 */
export function FileContentView({
  path,
  line,
  col,
  mode = 'raw',
}: {
  path: string;
  line?: number;
  col?: number;
  mode?: MarkdownMode;
}) {
  // Fetched once here, so flipping Preview/Raw does not refetch.
  const { content, error } = useFileContent(path);

  // Relative links resolve against the file's own directory. Without a handler
  // Markdown renders them as plain hrefs, which would navigate the app away.
  // Stable reference: Markdown is memo'd.
  const onLink = useCallback(
    (href: string) => {
      if (href.startsWith('#')) return;
      const target = href.replace(/[?#].*$/, '');
      if (!target) return;
      const abs =
        target.startsWith('/') || target.startsWith('~')
          ? target
          : '/' + normalizeDocPath(`${docDirname(path)}/${target}`);
      useStore.getState().openFilePreview(abs);
    },
    [path],
  );

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
  if (mode === 'preview') {
    return (
      <ScrollArea h="100%" type="hover">
        <Box className="docs-body" px="lg" pb="xl">
          <Markdown text={content} onLinkClick={onLink} />
        </Box>
      </ScrollArea>
    );
  }
  return <MonacoView path={path} content={content} line={line} col={col} />;
}

/** Main-pane files mode: tab bar of opened files + read-only Monaco editor. */
export function FilesView() {
  const activeProject = useStore((s) => s.activeProject);
  const openFiles = useStore((s) => activeProject ? s.openFiles[activeProject] : undefined);
  const isPhone = useIsPhone();
  const mdMode = useMarkdownMode(openFiles?.active ?? undefined);

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
      <Group gap={6} px="xs" py={6} wrap="nowrap">
        <Group gap={4} wrap="nowrap" style={{ flex: 1, minWidth: 0, overflowX: 'auto' }}>
          {openFiles.tabs.map((path) => (
            <FileTab
              key={path}
              path={path}
              project={activeProject}
              active={path === openFiles.active}
            />
          ))}
        </Group>
        <MarkdownModeToggle state={mdMode} />
      </Group>
      <Box style={{ flex: 1, minHeight: 0 }}>
        {openFiles.active ? (
          <FileContentView key={openFiles.active} path={openFiles.active} mode={mdMode?.[0]} />
        ) : (
          empty
        )}
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
  // Keyed by the hit, so picking another hit in a file left on Preview goes
  // back to Raw, where its line is visible.
  const mdMode = useMarkdownMode(preview?.path, { line: preview?.line, openKey: preview });
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
        <Group gap={6} wrap="nowrap">
          <MarkdownModeToggle state={mdMode} />
          <Tooltip label="Close preview">
            <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => setSearchPreview(null)}>
              <IconX size={13} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      <Box style={{ flex: 1, minHeight: 0 }}>
        <FileContentView
          key={preview.path}
          path={preview.path}
          line={preview.line}
          col={preview.col}
          mode={mdMode?.[0]}
        />
      </Box>
    </Stack>
  );
}
