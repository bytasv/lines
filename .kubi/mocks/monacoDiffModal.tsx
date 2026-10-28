import { Code, Modal, SimpleGrid } from '@mantine/core';

// The real modal pulls in Monaco and its `?worker` imports, which only Vite can
// build. A plain side-by-side keeps the diff button working in Kubi.
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
  return (
    <Modal opened={opened} onClose={onClose} title={filePath} size="xl">
      <SimpleGrid cols={2}>
        <Code block>{before}</Code>
        <Code block>{after}</Code>
      </SimpleGrid>
    </Modal>
  );
}
