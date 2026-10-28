import { TaskBody } from '../../web/src/components/TaskCall';

export default {
  component: TaskBody,
  title: 'Transcript/TaskBody',
  argTypes: {
    tool: { type: 'object' },
  },
  args: {
    tool: {
      type: 'tool',
      id: 'toolu_task_1',
      name: 'Task',
      input: {
        description: 'Find where the relay drops reconnects',
        prompt:
          'Look through server/src/relay.ts and list every path that closes the socket with 1008.\n\n' +
          'For each one, say:\n- what triggers it\n- whether the client retries\n\nDo not edit any files.',
        subagent_type: 'Explore',
      },
    },
  },
  decorators: [(Story: React.ComponentType) => <div style={{ maxWidth: 640 }}><Story /></div>],
};

export const Default = {};
