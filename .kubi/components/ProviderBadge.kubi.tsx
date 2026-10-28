import { ProviderBadge } from '../../web/src/components/ProviderMark';

export default {
  component: ProviderBadge,
  title: 'Brand/ProviderBadge',
  argTypes: {
    provider: { type: 'enum', options: ['anthropic', 'openai'] },
  },
  args: { provider: 'anthropic' },
  // Absolutely positioned at the corner of a usage ring; a stand-in ring gives it a box.
  decorators: [
    (Story: React.ComponentType) => (
      <div
        style={{
          position: 'relative',
          width: 32,
          height: 32,
          borderRadius: '50%',
          border: '3px solid var(--mantine-color-dark-4)',
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export const Anthropic = {};
export const OpenAI = { args: { provider: 'openai' } };
