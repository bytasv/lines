import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  Alert,
  ActionIcon,
  Box,
  Button,
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
import { useIsGuest } from '../lib/can';
import { MOD } from '../lib/platform';
import { saveFile, useFileContent, useMediaUrl } from '../lib/files';
import { isMarkdownPath, languageFor, mediaKindFor, type MediaKind } from '../lib/language';
import { Markdown } from './Markdown';

function FileTab({ path, project, active }: { path: string; project: string; active: boolean }) {
  const setActiveFileTab = useStore((s) => s.setActiveFileTab);
  const closeFileTab = useStore((s) => s.closeFileTab);
  const dirty = useStore((s) => !!s.dirtyFiles[path]);
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
        {dirty && <DirtyDot />}
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

function MonacoView({
  path,
  content,
  line,
  col,
  editable = false,
  onChange,
  onSave,
  editorRef,
}: {
  path: string;
  content: string;
  line?: number;
  col?: number;
  editable?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
  /** Holds the editor while it is mounted, for Discard and refocusing. */
  editorRef?: MutableRefObject<MonacoEditor | null>;
}) {
  const colorScheme = useComputedColorScheme('dark');
  const [editor, setEditor] = useState<MonacoEditor | null>(null);
  // Uncontrolled after mount: the text it opened with, never fed back from the
  // draft, so typing cannot move the cursor. Discard edits it in place; a reload
  // remounts it.
  const [initial] = useState(content);
  // The save command is registered once on mount; this keeps it on the latest draft.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!editor || !editorRef) return;
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
    };
  }, [editor, editorRef]);

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
      defaultValue={initial}
      theme={colorScheme === 'dark' ? 'vs-dark' : 'light'}
      onMount={(mounted, monaco) => {
        setEditor(mounted);
        if (editable) {
          mounted.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current?.());
        }
      }}
      onChange={(value) => onChange?.(value ?? '')}
      options={{
        readOnly: !editable,
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

const MEDIA_FILL = { width: '100%', height: '100%', border: 0 } as const;

/**
 * An image, video, audio clip or pdf, rendered by the browser from a blob URL.
 * SVG goes through `<img>` like any other image, so its scripts never run.
 */
function MediaView({ path, kind }: { path: string; kind: MediaKind }) {
  const { url, error, progress } = useMediaUrl(path);
  if (error) {
    return (
      <Alert color="red" m="xs">
        {error}
      </Alert>
    );
  }
  if (!url) {
    return (
      <Center h="100%">
        <Stack align="center" gap="xs">
          <Loader />
          <Text size="xs" c="dimmed">
            Loading… {Math.round(progress * 100)}%
          </Text>
        </Stack>
      </Center>
    );
  }
  if (kind === 'pdf') return <iframe src={url} title={path} style={MEDIA_FILL} />;
  return (
    <Center h="100%" p="md">
      {kind === 'image' && (
        <img src={url} alt={path} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
      )}
      {kind === 'video' && <video controls src={url} style={{ maxWidth: '100%', maxHeight: '100%' }} />}
      {kind === 'audio' && <audio controls src={url} />}
    </Center>
  );
}

/**
 * A workspace file: the browser's own rendering for media (read-only), rendered
 * markdown when `mode` is `'preview'`, Monaco otherwise — editable on your own
 * machine. The mode comes from the host's header (`useMarkdownMode`), and the
 * save controls go back into it, through `actionsSlot` (see `FileActionsSlot`).
 */
export function FileContentView(props: {
  path: string;
  line?: number;
  col?: number;
  mode?: MarkdownMode;
  actionsSlot?: HTMLElement | null;
}) {
  // Branch before any text fetch, so media never goes through the `file` kind.
  const kind = mediaKindFor(props.path);
  if (kind) return <MediaView path={props.path} kind={kind} />;
  return <TextContentView {...props} />;
}

function TextContentView({
  path,
  line,
  col,
  mode = 'raw',
  actionsSlot,
}: {
  path: string;
  line?: number;
  col?: number;
  mode?: MarkdownMode;
  actionsSlot?: HTMLElement | null;
}) {
  // Fetched once here, so flipping Preview/Raw does not refetch.
  const [reloadKey, setReloadKey] = useState(0);
  const { content, mtimeMs, error } = useFileContent(path, reloadKey);
  // Saving is owner-only on the bridge too; this only keeps a guest from typing
  // into an editor whose every save would be refused.
  const editable = !useIsGuest();
  const setFileDirty = useStore((s) => s.setFileDirty);

  // The edit lives here rather than in Monaco, so Preview renders the unsaved
  // draft. `saved` is what the last save wrote — the new base without a refetch.
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [baseMtime, setBaseMtime] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const editorRef = useRef<MonacoEditor | null>(null);

  // A fresh read (first load or Reload) is the new base; any draft is gone with it.
  useEffect(() => {
    setDraft(null);
    setSaved(null);
    setBaseMtime(mtimeMs);
    setSaveError(null);
    setConflict(false);
  }, [content, mtimeMs]);

  const base = saved ?? content;
  const dirty = draft !== null && draft !== base;

  useEffect(() => {
    setFileDirty(path, dirty);
  }, [path, dirty, setFileDirty]);
  useEffect(() => () => setFileDirty(path, false), [path, setFileDirty]);

  // The clicked button leaves with the controls, so focus goes back to the text
  // — unless the user has moved it somewhere else in the meantime.
  const refocus = () => {
    const active = document.activeElement;
    if (active && active !== document.body && !actionsSlot?.contains(active)) return;
    editorRef.current?.focus();
  };

  const save = async (overwrite = false) => {
    if (!editable || saving || draft === null || (!dirty && !overwrite)) return;
    const text = draft;
    setSaving(true);
    setSaveError(null);
    try {
      // No mtime from an old bridge (or Overwrite): the write is unconditional.
      const result = await saveFile(path, text, overwrite || baseMtime === null ? undefined : baseMtime);
      if (result.conflict) {
        setConflict(true);
        return;
      }
      // Compared against `draft`, not cleared: typing during the save stays dirty.
      setSaved(text);
      setBaseMtime(result.mtimeMs);
      setConflict(false);
      useStore.getState().noteFileSaved(path);
      refocus();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (editor && model && base !== null) {
      // In place rather than a remount, so the scroll and cursor stay put and
      // the discard is one undo away.
      const view = editor.saveViewState();
      editor.pushUndoStop();
      editor.executeEdits('discard', [{ range: model.getFullModelRange(), text: base }]);
      editor.pushUndoStop();
      if (view) editor.restoreViewState(view);
    }
    setDraft(null);
    setSaveError(null);
    setConflict(false);
    refocus();
  };

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
  if (base === null) {
    return (
      <Center h="100%">
        <Loader />
      </Center>
    );
  }
  const text = draft ?? base;
  const body =
    mode === 'preview' ? (
      <ScrollArea h="100%" type="hover">
        <Box className="docs-body" px="lg" pb="xl">
          <Markdown text={text} onLinkClick={onLink} />
        </Box>
      </ScrollArea>
    ) : (
      <MonacoView
        path={path}
        content={text}
        line={line}
        col={col}
        editable={editable}
        onChange={setDraft}
        onSave={() => void save()}
        editorRef={editorRef}
      />
    );
  // Portalled into the host's header rather than stacked over the body: the body
  // keeps one shape whether or not the controls show, so the first keystroke
  // neither remounts the editor (losing focus) nor pushes the text down.
  const showControls = dirty || !!saveError || conflict;
  return (
    <>
      {body}
      {showControls &&
        actionsSlot &&
        createPortal(
          <SaveControls
            conflict={conflict}
            error={saveError}
            saving={saving}
            onSave={() => void save()}
            onDiscard={discard}
            onOverwrite={() => void save(true)}
            onReload={() => setReloadKey((k) => k + 1)}
          />,
          actionsSlot,
        )}
    </>
  );
}

/**
 * Where a host's header shows the open file's save controls, next to its own
 * buttons. `display: contents` so it adds no box, and no gap, while empty.
 */
export function FileActionsSlot({ onSlot }: { onSlot: (el: HTMLDivElement | null) => void }) {
  return <div ref={onSlot} style={{ display: 'contents' }} />;
}

function DirtyDot() {
  return (
    <Box
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: 'var(--mantine-primary-color-filled)',
        flexShrink: 0,
      }}
    />
  );
}

/** A file's save state, for its host's header: unsaved, failed, or stale on disk. */
function SaveControls({
  conflict,
  error,
  saving,
  onSave,
  onDiscard,
  onOverwrite,
  onReload,
}: {
  conflict: boolean;
  error: string | null;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onOverwrite: () => void;
  onReload: () => void;
}) {
  const problem = conflict ? 'Changed on disk' : error;
  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
      {problem ? (
        <Text size="xs" c="red" truncate maw={280} title={problem}>
          {problem}
        </Text>
      ) : (
        <>
          <DirtyDot />
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            Unsaved changes · {MOD}S
          </Text>
        </>
      )}
      {conflict ? (
        <>
          <Button size="compact-xs" variant="subtle" color="gray" disabled={saving} onClick={onReload}>
            Reload
          </Button>
          <Button size="compact-xs" variant="light" color="red" loading={saving} onClick={onOverwrite}>
            Overwrite
          </Button>
        </>
      ) : (
        <>
          <Button size="compact-xs" variant="subtle" color="gray" disabled={saving} onClick={onDiscard}>
            Discard
          </Button>
          <Button size="compact-xs" variant="light" loading={saving} onClick={onSave}>
            Save
          </Button>
        </>
      )}
    </Group>
  );
}

/** Main-pane files mode: tab bar of opened files + a Monaco editor. */
export function FilesView() {
  const activeProject = useStore((s) => s.activeProject);
  const openFiles = useStore((s) => activeProject ? s.openFiles[activeProject] : undefined);
  const isPhone = useIsPhone();
  const mdMode = useMarkdownMode(openFiles?.active ?? undefined);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);

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
        <FileActionsSlot onSlot={setActionsSlot} />
        <MarkdownModeToggle state={mdMode} />
      </Group>
      <Box style={{ flex: 1, minHeight: 0 }}>
        {openFiles.active ? (
          <FileContentView
            key={openFiles.active}
            path={openFiles.active}
            mode={mdMode?.[0]}
            actionsSlot={actionsSlot}
          />
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
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
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
          <FileActionsSlot onSlot={setActionsSlot} />
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
          actionsSlot={actionsSlot}
        />
      </Box>
    </Stack>
  );
}
