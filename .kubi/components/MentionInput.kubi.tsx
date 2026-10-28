import { useRef, useState } from 'react';
import { MentionInput } from '../../web/src/components/MentionInput';
import { withComposerColumn } from '../decorators';

type Args = React.ComponentProps<typeof MentionInput>;

/** MentionInput is controlled and needs a textarea ref; hold both here. */
function Controlled(args: Args) {
  const [value, setValue] = useState(args.value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  return (
    <MentionInput
      {...args}
      value={value}
      onChange={(next) => {
        setValue(next);
        args.onChange?.(next);
      }}
      textareaRef={textareaRef}
    />
  );
}

const withPill = 'Cap the reconnect delay in @ws.ts and add jitter';

export default {
  component: MentionInput,
  title: 'Composer/MentionInput',
  argTypes: {
    value: { type: 'object' },
    placeholder: { type: 'string' },
    cwd: { type: 'string' },
    roots: { type: 'array' },
    minRows: { type: 'number' },
    onChange: { action: 'changed' },
    onSubmit: { action: 'submitted' },
    onFocusChange: { action: 'focusChanged' },
    onPasteFiles: { action: 'pastedFiles' },
  },
  args: {
    value: { text: '', ranges: [] },
    placeholder: 'Message Claude… (↵ to send, ⇧↵ for newline)',
    cwd: '/Users/dev/projects/lines',
    roots: ['/Users/dev/projects/lines'],
    minRows: 2,
  },
  // Keyed on the value so an inspector edit re-seeds the local state.
  render: (args: Args) => <Controlled key={JSON.stringify(args.value)} {...args} />,
  decorators: [withComposerColumn],
};

export const Empty = {};
export const WithMention = {
  args: {
    value: {
      text: withPill,
      ranges: [
        {
          kind: 'file',
          id: 'web/src/ws.ts',
          label: 'ws.ts',
          expansion: '@web/src/ws.ts',
          start: withPill.indexOf('@ws.ts'),
          end: withPill.indexOf('@ws.ts') + '@ws.ts'.length,
        },
      ],
    },
  },
};
export const Phone = { args: { minRows: 1, placeholder: 'Message Claude…' } };
