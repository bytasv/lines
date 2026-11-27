import { ToolCallCard } from '../../web/src/components/ToolCallCard';

export default {
  component: ToolCallCard,
  title: 'Transcript/ToolCallCard',
  argTypes: {
    tool: { type: 'object' },
  },
  args: {
    tool: {
      type: 'tool',
      id: 'toolu_read_1',
      name: 'Read',
      input: { file_path: 'web/src/components/ConfirmModal.tsx' },
      result: "import { Button, Group, Modal, Text } from '@mantine/core';\n…",
    },
  },
  decorators: [(Story: React.ComponentType) => <div style={{ maxWidth: 640 }}><Story /></div>],
};

export const Read = {};
export const Bash = {
  args: {
    tool: {
      type: 'tool',
      id: 'toolu_bash_1',
      name: 'Bash',
      input: { command: 'npm run typecheck -w web', description: 'Typecheck the web app' },
      result: '> @lines/web@0.1.22 typecheck\n> tsc --noEmit',
    },
  },
};
export const Running = {
  args: {
    tool: {
      type: 'tool',
      id: 'toolu_grep_1',
      name: 'Grep',
      input: { pattern: 'useStore', path: 'web/src/components' },
    },
  },
};
export const Failed = {
  args: {
    tool: {
      type: 'tool',
      id: 'toolu_bash_2',
      name: 'Bash',
      input: { command: 'npm test -w server' },
      result: 'FAIL src/relay.test.ts\n  ✕ reconnects after 1008 (12 ms)',
      isError: true,
    },
  },
};
export const McpTool = {
  args: {
    tool: {
      type: 'tool',
      id: 'toolu_mcp_issue',
      name: 'mcp__linear__create_issue',
      input: { title: 'Session list times out on fra1', team: 'LIN' },
      result: 'Created LIN-482',
    },
  },
};
export const McpToolUnknownProvider = {
  args: {
    tool: {
      type: 'tool',
      id: 'toolu_mcp_acme',
      name: 'mcp__acme_tracker__listOpenTickets',
      input: { assignee: 'me' },
      result: '3 tickets',
    },
  },
};
export const McpToolFailed = {
  args: {
    tool: {
      type: 'tool',
      id: 'toolu_mcp_figma',
      name: 'mcp__figma__get_screenshot',
      input: { nodeId: '12:345' },
      result: 'The user denied this tool call.',
      isError: true,
    },
  },
};
