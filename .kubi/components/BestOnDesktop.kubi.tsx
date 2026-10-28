import { BestOnDesktop } from '../../web/src/components/BestOnDesktop';

export default {
  component: BestOnDesktop,
  title: 'Feedback/BestOnDesktop',
  argTypes: {
    what: { type: 'string' },
    onClose: { action: 'closed' },
  },
  args: { what: 'Editing a workflow' },
  decorators: [(Story: React.ComponentType) => <div style={{ height: 320 }}><Story /></div>],
};

export const Default = {};
export const WithoutBack = { args: { what: 'The diff viewer', onClose: undefined } };
