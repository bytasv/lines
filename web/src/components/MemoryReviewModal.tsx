import { Badge, Button, Code, Group, Modal, ScrollArea, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { MemoryReviewEntry } from '@lines/shared';
import { useStore } from '../store';

/**
 * Agent memory pulled from another machine is never written silently — this is
 * the gate, and it is the same shape as the allowlist review beside it.
 *
 * The reason it has to exist: these files are read into the prompt of every
 * session on the machine, `CLAUDE.md` into all of them. A write applied without
 * being seen is instructions the user never wrote, running on their machine,
 * indefinitely. Mounted next to the login modal rather than inside Settings for
 * the same reason as the guard's: notification cannot sit behind a gear click.
 */
export function MemoryReviewModal() {
  const review = useStore((s) => s.memoryReview);
  const opened = useStore((s) => s.memoryReviewOpen);
  const closeMemoryReview = useStore((s) => s.closeMemoryReview);
  const resolveMemoryReview = useStore((s) => s.resolveMemoryReview);

  return (
    <Modal
      opened={opened && review != null}
      onClose={closeMemoryReview}
      title="Agent memory changed on another machine"
      size="lg"
      centered
    >
      <Stack gap="sm">
        <Text size="sm">
          These memory files were pulled from cloud sync. They are read into every session on this
          machine, so nothing is written to disk until you accept.
        </Text>
        <ScrollArea.Autosize mah={360}>
          <Stack gap="sm">
            {review?.entries.map((entry) => <EntryRow key={`${entry.key}:${entry.change}`} entry={entry} />)}
          </Stack>
        </ScrollArea.Autosize>
        <Group justify="flex-end" gap="xs" mt="xs">
          <Button variant="default" onClick={() => resolveMemoryReview(false)}>
            Keep mine
          </Button>
          <Button onClick={() => resolveMemoryReview(true)}>Apply changes</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

const CHANGE_COLOR = { add: 'orange', update: 'orange', delete: 'red' } as const;

/**
 * One staged write, with the incoming content shown in full. Deliberately the
 * whole text rather than a line diff: what matters is what the agent would read,
 * and a diff hunk hides the paragraph around the inserted sentence.
 */
function EntryRow({ entry }: { entry: MemoryReviewEntry }) {
  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="nowrap">
        <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" />
        <Code>{entry.key}</Code>
        <Badge color={CHANGE_COLOR[entry.change]} variant="light">
          {entry.change}
        </Badge>
      </Group>
      {entry.targets.map((target) => (
        <Text key={target} size="xs" c="dimmed" ff="monospace" truncate>
          {target}
        </Text>
      ))}
      {entry.change !== 'delete' && (
        <Code block style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
          {entry.content}
        </Code>
      )}
    </Stack>
  );
}
