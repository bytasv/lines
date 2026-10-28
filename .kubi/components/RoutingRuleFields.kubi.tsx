import { RoutingRuleFields } from '../../web/src/components/RoutingRuleFields';

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', provider: 'anthropic' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', provider: 'anthropic' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', provider: 'anthropic' },
];

export default {
  component: RoutingRuleFields,
  title: 'Settings/RoutingRuleFields',
  argTypes: {
    provider: { type: 'enum', options: ['anthropic', 'openai'] },
    models: { type: 'array' },
    value: { type: 'object' },
    disabled: { type: 'boolean' },
    onChange: { action: 'changed' },
  },
  args: {
    provider: 'anthropic',
    models: MODELS,
    value: {
      rule: 'Max effort for architecture or debugging questions, or after a failed turn; low for small edits.',
      models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
      efforts: [],
    },
    disabled: false,
  },
  decorators: [(Story: React.ComponentType) => <div style={{ maxWidth: 480 }}><Story /></div>],
};

export const Filled = {};
export const Empty = { args: { value: { rule: '', models: [], efforts: [] } } };
export const Disabled = { args: { disabled: true } };
