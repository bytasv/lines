import { Modal, Text, Center, Loader, Alert, Box, Group } from '@mantine/core';
import { useComputedColorScheme } from '@mantine/core';
import { Editor } from '@monaco-editor/react';
import { projectRoots } from '@lines/shared';
import { useStore } from '../store';
import { useFileContent } from '../lib/files';
import { languageFor } from '../lib/language';
import { FileTree } from './FileTree';

export function MonacoPreviewModal() {
  const filePreview = useStore((s) => s.filePreview);
  const closeFilePreview = useStore((s) => s.closeFilePreview);
  const openFilePreview = useStore((s) => s.openFilePreview);
  const projects = useStore((s) => s.projects);
  const activeProject = useStore((s) => s.activeProject);
  const colorScheme = useComputedColorScheme('dark');

  const path = filePreview?.path;
  const line = filePreview?.line;
  const { content, error } = useFileContent(path);

  // Root the tree at the root that contains the previewed file — any root of any
  // open project, since a project spans several — else the active project.
  const treeRoot =
    (path && projects.flatMap(projectRoots).find((r) => path === r || path.startsWith(r + '/'))) ??
    activeProject;

  return (
    <Modal
      opened={filePreview !== null}
      onClose={closeFilePreview}
      fullScreen
      padding="xs"
      title={
        <Text ff="monospace" size="sm" fw={600}>
          {filePreview?.display ?? ''}
          {line ? `:${line}` : ''}
        </Text>
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
          {error ? (
            <Alert color="red">{error}</Alert>
          ) : content === null ? (
            <Center h="100%">
              <Loader />
            </Center>
          ) : (
            <Editor
              key={path}
              height="100%"
              language={filePreview ? languageFor(filePreview.display) : 'plaintext'}
              value={content}
              theme={colorScheme === 'dark' ? 'vs-dark' : 'light'}
              onMount={(editor, monaco) => {
                if (!line) return;
                const model = editor.getModel();
                editor.revealLineInCenter(line);
                editor.setPosition({ lineNumber: line, column: filePreview?.col ?? 1 });
                if (model) {
                  editor.setSelection(
                    new monaco.Selection(line, 1, line, model.getLineMaxColumn(line)),
                  );
                }
              }}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
                automaticLayout: true,
              }}
            />
          )}
        </Box>
      </Group>
    </Modal>
  );
}
