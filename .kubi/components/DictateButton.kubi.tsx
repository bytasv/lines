import { DictateButton } from '../../web/src/components/DictateButton';

// A stand-in for useVoiceDictation's result: the button only renders from it.
const dictation = (over: Record<string, unknown> = {}) => ({
  voice: 'idle',
  voiceError: null,
  setVoiceError: () => {},
  voiceLevel: null,
  elapsed: 0,
  remainingMs: null,
  canExtend: true,
  extend: () => {},
  voiceBlock: null,
  voiceBlockActionable: false,
  start: async () => {},
  finish: async () => {},
  cancel: () => {},
  commit: () => {},
  ...over,
});

export default {
  component: DictateButton,
  title: 'Composer/DictateButton',
  argTypes: {
    dictation: { type: 'object' },
    iconSize: { type: 'number' },
    size: { control: 'select', options: ['xs', 'sm', 'md', 'lg', 'xl'] },
    disabledReason: { type: 'string' },
    showTimer: { control: 'boolean' },
    keepFocus: { control: 'boolean' },
    onBlockedClick: { action: 'blockedClick' },
    onPress: { action: 'pressed' },
  },
  args: {
    dictation: dictation(),
    iconSize: 16,
    size: 'lg',
  },
  // Kubi keeps args as data, so an edited `dictation` loses its callbacks;
  // put the stubs back under whatever state the inspector holds.
  render: (args: React.ComponentProps<typeof DictateButton>) => (
    <DictateButton {...args} dictation={dictation(args.dictation as Record<string, unknown>)} />
  ),
};

export const Idle = {};
export const Recording = { args: { dictation: dictation({ voice: 'recording', elapsed: 12_400 }), showTimer: true } };
export const RecordingNearLimit = {
  args: { dictation: dictation({ voice: 'recording', elapsed: 100_000, remainingMs: 20_000 }), showTimer: true },
};
export const RecordingAtCeiling = {
  args: {
    dictation: dictation({ voice: 'recording', elapsed: 580_000, remainingMs: 20_000, canExtend: false }),
    showTimer: true,
  },
};
export const Transcribing = { args: { dictation: dictation({ voice: 'transcribing' }) } };
export const Blocked = {
  args: {
    dictation: dictation({ voiceBlock: 'Voice input is not set up on this machine', voiceBlockActionable: true }),
  },
};
