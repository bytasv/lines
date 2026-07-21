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
