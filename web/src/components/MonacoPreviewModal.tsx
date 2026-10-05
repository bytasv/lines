import { useState } from 'react';
import { Modal, Text, Box, Group } from '@mantine/core';
import { projectRoots } from '@lines/shared';
import { useStore } from '../store';
import { useIsPhone } from '../lib/layout';
import { BestOnDesktop } from './BestOnDesktop';
import { FileTree } from './FileTree';
// The editor (and its monacoSetup import) lives in FilesView; this module is
// only reached through React.lazy, which keeps both out of the entry chunk.
import { FileActionsSlot, FileContentView, MarkdownModeToggle, useMarkdownMode } from './FilesView';

export function MonacoPreviewModal() {
  const filePreview = useStore((s) => s.filePreview);
  const closeFilePreview = useStore((s) => s.closeFilePreview);
  const openFilePreview = useStore((s) => s.openFilePreview);
  const projects = useStore((s) => s.projects);
  const activeProject = useStore((s) => s.activeProject);

  const path = filePreview?.path;
  const line = filePreview?.line;
  const isPhone = useIsPhone();
  // Keyed by the preview object, not the path: each openFilePreview is a new
  // open, so the toggle starts over even when the same file is reopened.
  const mdMode = useMarkdownMode(path, { line, forceRaw: filePreview?.raw, openKey: filePreview });
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);

  // Root the tree at the root that contains the previewed file — any root of any
  // open project, since a project spans several — else the active project.
  const treeRoot =
    (path && projects.flatMap(projectRoots).find((r) => path === r || path.startsWith(r + '/'))) ??
    activeProject;

  if (isPhone) {
    return (
      <Modal opened={filePreview !== null} onClose={closeFilePreview} fullScreen>
        <BestOnDesktop what="Reading source" onClose={closeFilePreview} />
      </Modal>
    );
  }

  return (
    <Modal
      opened={filePreview !== null}
      onClose={closeFilePreview}
      fullScreen
      padding="xs"
      styles={{ title: { flex: 1, minWidth: 0, marginRight: 'var(--mantine-spacing-xs)' } }}
      title={
        <Group gap="xs" wrap="nowrap" justify="space-between">
          <Text ff="monospace" size="sm" fw={600} truncate>
            {filePreview?.display ?? ''}
            {line ? `:${line}` : ''}
          </Text>
          <Group gap={6} wrap="nowrap">
            <FileActionsSlot onSlot={setActionsSlot} />
            <MarkdownModeToggle state={mdMode} />
          </Group>
        </Group>
      }
    >
      <Group align="stretch" gap={0} wrap="nowrap" h="calc(100vh - 70px)">
        {treeRoot && (
          <Box
            w={260}
            style={{
              flexShrink: 0,
              borderRight: '1px solid var(--mantine-color-default-border)',
              overflow: 'auto',
            }}
          >
            <FileTree
              key={treeRoot}
              root={treeRoot}
              onFileClick={(p) => openFilePreview(p)}
              selectedPath={path ?? null}
            />
          </Box>
        )}
        <Box style={{ flex: 1, minWidth: 0 }}>
          {path && (
            <FileContentView
              key={path}
              path={path}
              line={line}
              col={filePreview?.col}
              mode={mdMode?.[0]}
              actionsSlot={actionsSlot}
            />
          )}
        </Box>
      </Group>
    </Modal>
  );
}
