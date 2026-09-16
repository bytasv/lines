import { Button, Group, Modal, Text } from '@mantine/core';
import type { MantineColor } from '@mantine/core';

export function ConfirmModal({
  opened,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmColor,
  confirmLoading,
  onConfirm,
  onCancel,
}: {
  opened: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  confirmColor?: MantineColor;
  /**
   * The confirmed action is still in flight. The modal stays up with a loading
   * button rather than closing on click, for an action whose effect takes long
   * enough that a closed dialog would read as "nothing happened" — a provider
   * switch waits on a summary query for up to a minute.
   */
  confirmLoading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      opened={opened}
      onClose={confirmLoading ? () => {} : onCancel}
      title={title}
      size="sm"
      centered
    >
      <Text size="sm" mb="md">
        {message}
      </Text>
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onCancel} disabled={confirmLoading}>
          {cancelLabel}
        </Button>
        <Button color={confirmColor} onClick={onConfirm} loading={confirmLoading}>
          {confirmLabel}
        </Button>
      </Group>
    </Modal>
  );
}
