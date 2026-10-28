import { Group } from '@mantine/core';
import { TaskHeader } from '../../web/src/components/TaskCall';

const EXPLORE_TASK = {
  type: 'tool',
  id: 'toolu_task_1',
  name: 'Task',
  input: {
    description: 'Find where the relay drops reconnects',
    prompt: 'Look through server/src/relay.ts and list every path that closes the socket with 1008.',
    subagent_type: 'Explore',
  },
};

const NESTED = [
  { type: 'tool', id: 'toolu_n1', name: 'Grep', input: { pattern: '1008', path: 'server/src' }, result: '3 matches' },
  { type: 'tool', id: 'toolu_n2', name: 'Read', input: { file_path: 'server/src/relay.ts' }, result: '…' },
  { type: 'tool', id: 'toolu_n3', name: 'Read', input: { file_path: 'server/src/hub.ts' }, result: '…' },
];

export default {
  component: TaskHeader,
  title: 'Transcript/TaskHeader',
  argTypes: {
    tool: { type: 'object' },
    nested: { type: 'array' },
  },
  args: { tool: EXPLORE_TASK, nested: NESTED },
  // The header's pieces are siblings in ToolCallCard's row.
  decorators: [
    (Story: React.ComponentType) => (
      <Group gap="xs" wrap="nowrap" style={{ maxWidth: 640 }}>
        <Story />
      </Group>
    ),
  ],
};

export const Explore = {};
export const Background = {
  args: {
    tool: {
      ...EXPLORE_TASK,
      id: 'toolu_task_2',
      input: {
        description: 'Run the full server test suite',
        prompt: 'Run npm test -w server and summarise failures.',
        subagent_type: 'general-purpose',
        run_in_background: true,
        isolation: 'worktree',
        model: 'sonnet',
        name: 'tester',
      },
    },
    nested: [],
  },
};
export const Failed = { args: { tool: { ...EXPLORE_TASK, isError: true } } };
