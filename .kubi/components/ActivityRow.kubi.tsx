import { ActivityRow } from '../../web/src/components/ActivityRow';

export default {
  component: ActivityRow,
  title: 'Transcript/ActivityRow',
  argTypes: {
    startedAt: { type: 'number' },
    lastEventAt: { type: 'number' },
    live: { type: 'object' },
  },
  args: {
    live: { phase: 'responding' },
  },
};

export const Responding = {};
export const Thinking = {
  args: {
    live: {
      phase: 'thinking',
      thinkingPreview: 'The reconnect path re-reads the device list on every 1008, so the retry loop is…',
    },
  },
};
export const PreparingTool = { args: { live: { phase: 'tool-prep', toolName: 'Edit' } } };
export const Subagent = {
  args: { live: { phase: 'responding', subagent: true, subagentType: 'Explore' } },
};
export const Starting = { args: { live: null } };
