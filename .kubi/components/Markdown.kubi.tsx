import { Markdown } from '../../web/src/components/Markdown';

export default {
  component: Markdown,
  title: 'Transcript/Markdown',
  argTypes: {
    text: { type: 'string' },
    onLinkClick: { action: 'linkClicked' },
  },
  args: {
    text:
      'Done. The reconnect delay now:\n\n- caps at **30 s** instead of 60 s\n- uses *equal jitter*, so a fleet of tabs does not reconnect in lockstep\n\n```ts\nconst capped = Math.min(1000 * 2 ** attempt, 30_000);\nreturn capped / 2 + Math.random() * (capped / 2);\n```\n\nSee web/src/lib/backoff.ts:12 for the change.',
  },
  decorators: [(Story: React.ComponentType) => <div style={{ maxWidth: 720 }}><Story /></div>],
};

export const AgentAnswer = {};

export const Table = {
  args: {
    text:
      'Retry delays before and after the change:\n\n| Attempt | Before | After |\n| --- | --- | --- |\n| 1 | 2 s | 1–2 s |\n| 4 | 16 s | 8–16 s |\n| 8 | 60 s | 15–30 s |',
  },
};

export const TaskList = {
  args: {
    text:
      '## Plan\n\n1. Read the current `Sidebar` layout\n2. Move the project tabs into the header\n\n- [x] Update `web/src/components/ProjectTabs.tsx`\n- [x] Keep keyboard shortcuts working\n- [ ] ~~Add a new store slice~~ not needed\n\n> The collapsed sidebar keeps its width, so nothing reflows.',
  },
};

export const ColorsAndLinks = {
  args: {
    text:
      'The accent moves from `#228be6` to `#4c6ef5`, and the muted text uses rgb(134, 142, 150).\n\nDetails in the [Mantine theme docs](https://mantine.dev/theming/theme-object/) and web/src/theme.ts.',
  },
};

export const Plain = { args: { text: 'Both backoff tests pass.' } };
