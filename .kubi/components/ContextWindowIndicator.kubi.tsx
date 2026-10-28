import { ContextWindowIndicator } from '../../web/src/components/ContextWindowIndicator';
import { withSessionStore } from '../decorators';
import { SESSION_IDLE } from '../fixtures';

export default {
  component: ContextWindowIndicator,
  title: 'Composer/ContextWindowIndicator',
  argTypes: {
    session: { type: 'object' },
    inline: { control: 'boolean' },
  },
  args: {
    session: SESSION_IDLE,
    inline: false,
  },
  decorators: [withSessionStore],
};

export const Chip = {};
export const Inline = {
  args: { inline: true },
  decorators: [(Story: React.ComponentType) => <div style={{ maxWidth: 360 }}><Story /></div>],
};
export const NearlyFull = {
  args: {
    session: {
      ...SESSION_IDLE,
      contextSummary: {
        ...SESSION_IDLE.contextSummary!,
        totalTokens: 870_000,
        percentage: 87,
        categories: [
          { name: 'System prompt', tokens: 3_100 },
          { name: 'System tools', tokens: 14_800 },
          { name: 'Messages', tokens: 852_100 },
        ],
      },
    },
  },
};
