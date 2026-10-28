import { ProviderMark } from '../../web/src/components/ProviderMark';

export default {
  component: ProviderMark,
  title: 'Brand/ProviderMark',
  argTypes: {
    provider: { type: 'enum', options: ['anthropic', 'openai'] },
    size: { type: 'number' },
  },
  args: { provider: 'anthropic', size: 24 },
};

export const Anthropic = {};
export const OpenAI = { args: { provider: 'openai' } };
export const Small = { args: { size: 10 } };
