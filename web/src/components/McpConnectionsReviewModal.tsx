import { Button, Code, Group, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { describeConnection, type McpConnection } from '@lines/shared';
import { useStore } from '../store';

/**
 * A remote connection list is never applied silently — this is the gate. Mounted
 * beside the allowlist review rather than inside SettingsModal for the same
 * reason: the requirement is that the user is *notified*, so the surface cannot
 * sit behind a gear click.
 *
 * Escape leaves the review pending (the Settings banner stays) and records the
 * dismissal, so a reconnect doesn't re-pop it in the same session. A bridge
 * restart legitimately re-opens it.
 */
export function McpConnectionsReviewModal() {
  const review = useStore((s) => s.mcpReview);
  const opened = useStore((s) => s.mcpReviewOpen);
  const closeMcpReview = useStore((s) => s.closeMcpReview);
  const resolveMcpReview = useStore((s) => s.resolveMcpReview);

  return (
    <Modal
      opened={opened && review != null}
      onClose={closeMcpReview}
      title="Connections changed on another machine"
      size="md"
      centered
    >
      <Stack gap="sm">
        <Text size="sm">
          Another machine’s MCP connections differ from this one’s. Applying them changes which
          third-party tools every session here can call, so nothing happens until you choose.
        </Text>
        {review && review.added.length > 0 && (
          <Stack gap={4}>
            <Text size="xs" fw={600} c="dimmed" tt="uppercase">
              Will be added
            </Text>
            {review.added.map((connection) => (
              <AddedRow key={connection.id} connection={connection} />
            ))}
          </Stack>
        )}
        {review && review.removed.length > 0 && (
          <Stack gap={4}>
            <Text size="xs" fw={600} c="dimmed" tt="uppercase">
              Will be removed
            </Text>
            {review.removed.map((connection) => (
              <Code key={connection.id} c="dimmed">
                {describeConnection(connection)}
              </Code>
            ))}
          </Stack>
        )}
        <Text size="xs" c="dimmed">
          An added connection arrives without its header values — enter them here after applying.
        </Text>
        <Group justify="flex-end" gap="xs" mt="xs">
          <Button variant="default" onClick={() => resolveMcpReview(false)}>
            Keep mine
          </Button>
          <Button onClick={() => resolveMcpReview(true)}>Apply changes</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** The widening half of the diff, so it carries the warning styling. */
function AddedRow({ connection }: { connection: McpConnection }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" />
      <Code c="orange">{describeConnection(connection)}</Code>
    </Group>
  );
}
