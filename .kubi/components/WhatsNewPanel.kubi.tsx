import { Paper } from '@mantine/core';
import { WhatsNewPanel } from '../../web/src/components/WhatsNew';

export default {
  component: WhatsNewPanel,
  title: 'Content/WhatsNewPanel',
  argTypes: {
    news: { type: 'object' },
    titleId: { type: 'string' },
    subtitle: { type: 'string' },
    listMaxHeight: { type: 'string' },
    onClose: { action: 'closed' },
  },
  args: {
    news: {
      web: [
        {
          version: '0.1.22',
          date: '2026-10-10',
          items: ['A dictated Send survives leaving the session before the transcript lands.'],
        },
        {
          version: '0.1.21',
          date: '2026-10-06',
          items: ['Steered messages appear where the agent read them.'],
        },
      ],
      desktop: [
        { version: '0.2.56', date: '2026-10-09', items: ['The tray shows which machine a session runs on.'] },
      ],
    },
    titleId: 'whats-new-title',
    subtitle: '3 updates since you last opened Lines',
    listMaxHeight: '320px',
  },
  decorators: [
    (Story: React.ComponentType) => (
      <Paper withBorder shadow="md" radius="lg" maw={460}>
        <Story />
      </Paper>
    ),
  ],
};

export const Default = {};
