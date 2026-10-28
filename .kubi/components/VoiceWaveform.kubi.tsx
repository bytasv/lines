import { VoiceWaveform } from '../../web/src/components/VoiceWaveform';

// A speech-like loudness probe: RMS wandering between ~0.01 and ~0.15.
let phase = 0;
const speechLevel = () => {
  phase += 0.35;
  return 0.01 + 0.07 * (1 + Math.sin(phase) * Math.sin(phase / 3.7)) * Math.random();
};

export default {
  component: VoiceWaveform,
  title: 'Composer/VoiceWaveform',
  argTypes: {
    height: { type: 'number' },
  },
  args: {
    height: 32,
  },
  // `level` is a function, so it cannot live in args: Kubi stores an instance's
  // args as data, and a missing probe would throw in the draw loop.
  render: (args: React.ComponentProps<typeof VoiceWaveform>) => (
    <VoiceWaveform {...args} level={typeof args.level === 'function' ? args.level : speechLevel} />
  ),
  decorators: [
    (Story: React.ComponentType) => (
      <div style={{ maxWidth: 640, color: 'var(--mantine-color-dimmed)' }}>
        <Story />
      </div>
    ),
  ],
};

export const Recording = {};
export const Phone = { args: { height: 24 } };
