import { ChangelogList } from '../../web/src/components/ChangelogList';

const WEB = [
  {
    version: '0.1.22',
    date: '2026-10-10',
    items: ['A dictated Send survives leaving the session before the transcript lands.'],
  },
  {
    version: '0.1.21',
    date: '2026-10-06',
    items: ['Steered messages appear where the agent read them.', 'Shared sessions show who is typing.'],
  },
];

const DESKTOP = [
  {
    version: '0.2.56',
    date: '2026-10-09',
    items: ['The tray shows which machine a session runs on.'],
  },
];

export default {
  component: ChangelogList,
  title: 'Content/ChangelogList',
  argTypes: {
    web: { type: 'array' },
    desktop: { type: 'array' },
    pending: { type: 'array' },
    highlightSince: { type: 'object' },
  },
  args: {
    web: WEB,
    desktop: DESKTOP,
  },
  decorators: [(Story: React.ComponentType) => <div style={{ maxWidth: 460 }}><Story /></div>],
};

export const Timeline = {};
export const WithNewBadges = { args: { highlightSince: { web: '0.1.20', desktop: '0.2.55' } } };
export const WithPending = {
  args: { pending: ['Faster reconnect after the laptop wakes.', 'Dictation on the lock screen.'] },
};
