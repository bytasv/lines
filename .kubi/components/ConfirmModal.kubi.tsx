import { ConfirmModal } from '../../web/src/components/ConfirmModal';

export default {
  component: ConfirmModal,
  title: 'Feedback/ConfirmModal',
  argTypes: {
    opened: { type: 'boolean' },
    title: { type: 'string' },
    message: { type: 'string' },
    confirmLabel: { type: 'string' },
    cancelLabel: { type: 'string' },
    confirmColor: {
      type: 'enum',
      options: ['mono', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'gray'],
    },
    confirmLoading: { type: 'boolean' },
    onConfirm: { action: 'confirmed' },
    onCancel: { action: 'cancelled' },
  },
  args: {
    opened: true,
    title: 'Delete session?',
    message: 'The transcript and its worktree will be removed from this machine. This cannot be undone.',
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    confirmColor: 'red',
    confirmLoading: false,
  },
};

export const Destructive = {};
export const Neutral = {
  args: {
    title: 'Switch to OpenAI?',
    message: 'The conversation so far is summarised and handed to the new provider.',
    confirmLabel: 'Switch',
    confirmColor: 'mono',
  },
};
export const Loading = { args: { confirmLoading: true } };
