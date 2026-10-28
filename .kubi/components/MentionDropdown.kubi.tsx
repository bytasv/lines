import { MentionDropdown } from '../../web/src/components/MentionAutocomplete';

export default {
  component: MentionDropdown,
  title: 'Composer/MentionDropdown',
  argTypes: {
    results: { type: 'array' },
    activeIndex: { type: 'number' },
    onSelect: { action: 'selected' },
  },
  args: {
    activeIndex: 0,
    results: [
      {
        kind: 'feature',
        id: 'relay-reconnect',
        label: 'Relay reconnect',
        detail: 'Backoff and resume for the browser ↔ bridge socket',
        expansion: 'Feature: Relay reconnect',
      },
      {
        kind: 'feature',
        id: 'offline-queue',
        label: 'Offline queue',
        detail: 'Prompts held in the browser while the link is down',
        expansion: 'Feature: Offline queue',
      },
      { kind: 'file', id: 'web/src/ws.ts', label: 'ws.ts', detail: 'web/src/ws.ts', expansion: '@web/src/ws.ts' },
      {
        kind: 'file',
        id: 'web/src/lib/backoff.ts',
        label: 'backoff.ts',
        detail: 'web/src/lib/backoff.ts',
        expansion: '@web/src/lib/backoff.ts',
      },
    ],
  },
  decorators: [(Story: React.ComponentType) => <div style={{ width: 360 }}><Story /></div>],
};

export const Results = {};
export const NoMatches = { args: { results: [] } };
