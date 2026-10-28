import { PermissionPrompt } from '../../web/src/components/PermissionPrompt';
import { withSessionStore } from '../decorators';
import { PENDING_BASH, SESSION_WAITING } from '../fixtures';

/**
 * The permission card the transcript shows when the agent asks to run a tool.
 * One component, several faces: the tool name picks the body (command, edit
 * diff, MCP connection, plan review) and `resolution` turns a pending card into
 * its collapsed, button-less record. The agent's name comes from the seeded
 * session store, so `sessionId` must be one of the fixture sessions.
 */
export default {
  component: PermissionPrompt,
  title: 'Transcript/PermissionPrompt',
  argTypes: {
    sessionId: { type: 'string' },
    data: { type: 'object' },
    resolution: { type: 'enum', options: ['allow', 'deny', 'expired'] },
  },
  args: {
    sessionId: SESSION_WAITING.id,
    data: { ...PENDING_BASH, alwaysAllowEntry: { tool: 'Bash', prefix: 'npx prisma' } },
  },
  decorators: [
    withSessionStore,
    (Story: React.ComponentType) => (
      <div style={{ maxWidth: 720 }}>
        <Story />
      </div>
    ),
  ],
};

export const PendingCommand = {};

export const PendingEdit = {
  args: {
    data: {
      requestId: 'perm_fx_edit',
      toolName: 'Edit',
      input: {
        file_path: 'web/src/lib/backoff.ts',
        old_string: '  return Math.min(1000 * 2 ** attempt, 60_000);',
        new_string:
          '  const capped = Math.min(1000 * 2 ** attempt, 30_000);\n  return capped / 2 + Math.random() * (capped / 2);',
      },
    },
  },
};

export const ConnectMcpServer = {
  args: {
    data: {
      requestId: 'perm_fx_mcp',
      toolName: 'mcp__lines__add_mcp_connection',
      input: {
        name: 'linear',
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
        source: 'https://linear.app/docs/mcp',
      },
      vetting: {
        level: 'known',
        reason: 'linear.app is the vendor’s own domain and matches the cited docs.',
        source: 'https://linear.app/docs/mcp',
      },
    },
  },
};

export const PlanReview = {
  args: {
    data: {
      requestId: 'perm_fx_plan',
      toolName: 'ExitPlanMode',
      input: {
        plan:
          '## Cap relay reconnect backoff\n\n1. Cap `nextDelay` at 30 s in `web/src/lib/backoff.ts`.\n2. Add equal jitter so tabs do not reconnect in lockstep.\n3. Reset the attempt counter on a clean `hello`.\n4. Cover the 1008 close path with fake-timer tests.',
      },
    },
  },
};

export const Denied = {
  args: {
    resolution: 'deny',
    data: { ...PENDING_BASH, denyMessage: 'Not against the shared database — use the local one.' },
  },
};
