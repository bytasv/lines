import { DictationError } from '../../web/src/components/DictateButton';

// A stand-in for useVoiceDictation's result: the error line only renders from it.
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
  component: DictationError,
  title: 'Composer/DictationError',
  argTypes: {
    dictation: { type: 'object' },
  },
  args: {
    dictation: dictation({ voiceError: 'Transcription failed — the recording was too short.' }),
  },
  // Kubi keeps args as data, so an edited `dictation` loses `setVoiceError`;
  // put the stubs back under whatever state the inspector holds.
  render: (args: React.ComponentProps<typeof DictationError>) => (
    <DictationError {...args} dictation={dictation(args.dictation as Record<string, unknown>)} />
  ),
};

export const Default = {};
