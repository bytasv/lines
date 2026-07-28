import { Button, Code, Group, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { describeAllowEntry, type GuardAllowEntry } from '@lines/shared';
import { useStore } from '../store';

/**
 * A remote allowlist is never applied silently — this is the gate. Mounted beside
 * the login modal rather than inside SettingsModal: the requirement is that the
 * user is *notified*, so the surface cannot sit behind a gear click.
 *
 * Escape leaves the review pending (the Settings banner stays) and records the
 * dismissal, so a reconnect doesn't re-pop it in the same session. A bridge
 * restart legitimately re-opens it.
 */
export function GuardAllowlistReviewModal() {
  const review = useStore((s) => s.guardReview);
  const opened = useStore((s) => s.guardReviewOpen);
  const closeGuardReview = useStore((s) => s.closeGuardReview);
  const resolveGuardReview = useStore((s) => s.resolveGuardReview);

  return (
    <Modal
      opened={opened && review != null}
      onClose={closeGuardReview}
      title="Allowlist changed on another machine"
      size="md"
      centered
    >
      <Stack gap="sm">
        <Text size="sm">
          Another machine’s auto-mode allowlist differs from this one’s. Applying it changes what
          Auto mode runs without asking, so nothing happens until you choose.
        </Text>
        {review && review.added.length > 0 && (
          <Stack gap={4}>
            <Text size="xs" fw={600} c="dimmed" tt="uppercase">
              Will start being allowed
            </Text>
            {review.added.map((entry) => (
              <AddedRow key={describeAllowEntry(entry)} entry={entry} />
            ))}
          </Stack>
        )}
        {review && review.removed.length > 0 && (
          <Stack gap={4}>
            <Text size="xs" fw={600} c="dimmed" tt="uppercase">
              Will stop being allowed
            </Text>
            {review.removed.map((entry) => (
              <Code key={describeAllowEntry(entry)} c="dimmed">
                {describeAllowEntry(entry)}
              </Code>
            ))}
          </Stack>
        )}
        <Group justify="flex-end" gap="xs" mt="xs">
          <Button variant="default" onClick={() => resolveGuardReview(false)}>
            Keep mine
          </Button>
          <Button onClick={() => resolveGuardReview(true)}>Apply changes</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** The widening half of the diff, so it carries the warning styling. */
function AddedRow({ entry }: { entry: GuardAllowEntry }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" />
      <Code c="orange">{describeAllowEntry(entry)}</Code>
    </Group>
  );
}
