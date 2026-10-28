import { ToolGroup } from '../../web/src/components/ToolGroup';
import { withSessionStore } from '../decorators';
import { SESSION_IDLE } from '../fixtures';

const group = {
  kind: 'tool-group',
  key: 'gtoolu_grp_read',
  labelText: 'Let me look at how the delay is computed first.',
  tools: [
    {
      type: 'tool',
      id: 'toolu_grp_read',
      name: 'Read',
      input: { file_path: 'web/src/lib/backoff.ts' },
      result: 'export function nextDelay(attempt: number): number {\n  return Math.min(1000 * 2 ** attempt, 60_000);\n}',
    },
    {
      type: 'tool',
      id: 'toolu_grp_grep',
      name: 'Grep',
      input: { pattern: 'nextDelay', path: 'web/src' },
      result: 'web/src/ws.ts:912\nweb/src/lib/backoff.ts:1',
    },
    {
      type: 'tool',
      id: 'toolu_grp_edit',
      name: 'Edit',
      input: {
        file_path: 'web/src/lib/backoff.ts',
        old_string: '  return Math.min(1000 * 2 ** attempt, 60_000);',
        new_string: '  const capped = Math.min(1000 * 2 ** attempt, 30_000);\n  return capped / 2 + Math.random() * (capped / 2);',
      },
      result: 'The file web/src/lib/backoff.ts has been updated.',
    },
  ],
};

export default {
  component: ToolGroup,
  title: 'Transcript/ToolGroup',
  argTypes: {
    group: { type: 'object' },
    active: { control: 'boolean' },
    sessionId: { type: 'string' },
  },
  args: {
    group,
    active: false,
    sessionId: SESSION_IDLE.id,
  },
  decorators: [withSessionStore, (Story: React.ComponentType) => <div style={{ maxWidth: 720 }}><Story /></div>],
};

export const Collapsed = {};
export const Live = {
  args: {
    active: true,
    group: {
      ...group,
      key: 'gtoolu_grp_live',
      tools: [
        ...group.tools.slice(0, 2),
        { type: 'tool', id: 'toolu_grp_bash', name: 'Bash', input: { command: 'npm test -w web -- backoff' } },
      ],
    },
  },
};
export const WithFailure = {
  args: {
    active: true,
    group: {
      ...group,
      key: 'gtoolu_grp_fail',
      tools: [
        group.tools[0],
        {
          type: 'tool',
          id: 'toolu_grp_bash_fail',
          name: 'Bash',
          input: { command: 'npm test -w web -- backoff' },
          result: 'FAIL src/lib/backoff.test.ts\n  ✕ backoff caps at 30s',
          isError: true,
        },
      ],
    },
  },
};
