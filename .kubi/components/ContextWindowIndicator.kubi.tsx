import { ContextWindowIndicator } from '../../web/src/components/ContextWindowIndicator';
import { withSessionStore } from '../decorators';
import { SESSION_IDLE, SESSION_MCP } from '../fixtures';

export default {
  component: ContextWindowIndicator,
  title: 'Composer/ContextWindowIndicator',
  argTypes: {
    session: { type: 'object' },
    inline: { control: 'boolean' },
  },
  args: {
    session: SESSION_IDLE,
    inline: false,
  },
  decorators: [withSessionStore],
};

export const Chip = {};
export const Inline = {
  args: { inline: true },
  decorators: [(Story: React.ComponentType) => <div style={{ maxWidth: 360 }}><Story /></div>],
};
export const NearlyFull = {
  args: {
    session: {
      ...SESSION_IDLE,
      contextSummary: {
        ...SESSION_IDLE.contextSummary!,
        totalTokens: 870_000,
        percentage: 87,
        categories: [
          { name: 'System prompt', tokens: 3_100 },
          { name: 'System tools', tokens: 14_800 },
          { name: 'Messages', tokens: 852_100 },
        ],
      },
    },
  },
};

/** Connections the session's MCP tools came from, as the owner sees them (status and the unused list). */
const MCP_STORE = {
  mcpStatus: {
    [SESSION_MCP.id]: [
      { name: 'vercel', status: 'connected' },
      { name: 'linear', status: 'connected' },
      { name: 'figma', status: 'connected' },
      { name: 'github', status: 'connected' },
      { name: 'sentry', status: 'needs-auth' },
    ],
  },
  contextBreakdowns: {
    [SESSION_MCP.id]: {
      at: SESSION_MCP.contextSummary!.at,
      loading: false,
      breakdown: {
        ...SESSION_MCP.contextSummary!,
        mcpServers: [
          { serverName: 'vercel', tokens: 18_400, toolCount: 41, tools: [] },
          { serverName: 'linear', tokens: 6_200, toolCount: 23, tools: [] },
          { serverName: 'figma', tokens: 4_900, toolCount: 12, tools: [] },
          { serverName: 'github', tokens: 9_100, toolCount: 30, tools: [] },
        ],
        memoryFiles: [],
        agents: [],
        systemTools: [],
        systemPromptSections: [],
        deferredTools: [],
      },
    },
  },
};

export const WithMcpCalls = {
  args: { session: SESSION_MCP },
  parameters: { store: MCP_STORE },
};
export const WithMcpCallsInline = {
  args: { session: SESSION_MCP, inline: true },
  parameters: { store: MCP_STORE },
  decorators: [(Story: React.ComponentType) => <div style={{ maxWidth: 360 }}><Story /></div>],
};
/** Servers connected, none called yet: the connections column shows its empty state. */
export const McpConnectedNoCalls = {
  parameters: {
    store: { mcpStatus: { [SESSION_IDLE.id]: [{ name: 'linear', status: 'connected' }, { name: 'figma', status: 'connected' }] } },
  },
};
