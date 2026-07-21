import { Modal, Text, Group, Badge } from '@mantine/core';
import { DiffEditor } from '@monaco-editor/react';
import { useComputedColorScheme } from '@mantine/core';
import { diffStats } from '../lib/transcript';
import { languageFor } from '../lib/language';

export function MonacoDiffModal({
  opened,
  onClose,
  filePath,
  before,
  after,
}: {
  opened: boolean;
  onClose: () => void;
  filePath: string;
  before: string;
  after: string;
}) {
  const colorScheme = useComputedColorScheme('dark');
  const stats = diffStats(before, after);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      fullScreen
      padding="xs"
      title={
        <Group gap="xs">
          <Text ff="monospace" size="sm" fw={600}>
            {filePath || 'untitled'}
          </Text>
          <Badge color="teal" variant="light">
            +{stats.added}
          </Badge>
          <Badge color="red" variant="light">
            −{stats.removed}
          </Badge>
        </Group>
      }
    >
      <DiffEditor
        height="calc(100vh - 70px)"
        language={languageFor(filePath)}
        original={before}
        modified={after}
        theme={colorScheme === 'dark' ? 'vs-dark' : 'light'}
        onMount={(editor) => {
          const reveal = () => {
            const changes = editor.getLineChanges();
            if (!changes || changes.length === 0) return;
            const first = changes[0];
            const line =
              first.modifiedStartLineNumber || first.originalStartLineNumber || 1;
            editor.getModifiedEditor().revealLineNearTop(line);
          };
          // Diff is computed async; wait for it before revealing.
          const d = editor.onDidUpdateDiff(() => {
            reveal();
            d.dispose();
          });
        }}
        options={{
          readOnly: true,
          renderSideBySide: true,
          minimap: { enabled: false },
          fontSize: 12,
          scrollBeyondLastLine: false,
          automaticLayout: true,
        }}
      />
    </Modal>
  );
}
