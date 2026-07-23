import { Button, Group, Modal, Text } from '@mantine/core';
import type { MantineColor } from '@mantine/core';

export function ConfirmModal({
  opened,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmColor,
  onConfirm,
  onCancel,
}: {
  opened: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  confirmColor?: MantineColor;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal opened={opened} onClose={onCancel} title={title} size="sm" centered>
      <Text size="sm" mb="md">
        {message}
      </Text>
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button color={confirmColor} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </Group>
    </Modal>
  );
}
