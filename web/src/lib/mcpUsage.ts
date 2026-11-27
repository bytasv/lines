import type { PermissionRequestData, TranscriptEvent } from '@lines/shared';
import { parseMcpToolName } from './mcpTools.ts';

/**
 * How the calls to one tool got permission. Approximate: a permission event
 * names its tool but not the tool_use it gated, so resolutions are counted per
 * tool name rather than matched to calls.
 */
export interface McpAccess {
  /** The user clicked Allow. */
  user: number;
  /** An allowlist entry (or the auto-mode guard) approved it without asking. */
  auto: number;
  /** Denied — by the user or by a rule. */
  denied: number;
  /** Calls no permission card was raised for: allowed by permission mode or settings. */
  unprompted: number;
}

export interface McpToolUsage {
  /** The tool's own name, without the `mcp__<server>__` prefix. */
  tool: string;
  calls: number;
  errors: number;
  access: McpAccess;
}

export interface McpUsage {
  server: string;
  calls: number;
  errors: number;
  /** Most-called first. */
  tools: McpToolUsage[];
}

interface SdkBlock {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

function contentOf(data: unknown): SdkBlock[] | null {
  const content = (data as { message?: { content?: unknown } } | null)?.message?.content;
  return Array.isArray(content) ? (content as SdkBlock[]) : null;
}

/** Resolution sources where a person answered the card. Absent reads as 'user' (older transcripts). */
const HUMAN = new Set(['user', 'plan-reply']);
/** Resolution sources where a rule answered it without asking. */
const RULE = new Set(['auto', 'plan-readonly', 'plan-ai-read']);

/**
 * The session's MCP calls, per server and tool, most-called first. Derived from
 * the transcript on the client and never persisted. Subagent calls count too:
 * they are assistant messages like any other, only with a parent tool id.
 */
export function summarizeMcpUsage(events: readonly TranscriptEvent[]): McpUsage[] {
  /** tool_use id -> full tool name, deduped (a message can be re-delivered). */
  const calls = new Map<string, string>();
  const failed = new Set<string>();
  /** requestId -> full tool name, from the request event. */
  const asked = new Map<string, string>();
  const access = new Map<string, McpAccess>();
  const accessOf = (name: string) => {
    let a = access.get(name);
    if (!a) access.set(name, (a = { user: 0, auto: 0, denied: 0, unprompted: 0 }));
    return a;
  };

  for (const event of events) {
    if (event.kind === 'permission') {
      const data = event.data as PermissionRequestData;
      if (!data?.requestId || data.elicitation) continue;
      const known = asked.get(data.requestId);
      const name = known ?? data.toolName;
      if (!known && name && parseMcpToolName(name)) asked.set(data.requestId, name);
      if (!name || !parseMcpToolName(name) || !data.resolution || data.resolution === 'expired') continue;
      const by = data.resolvedBy ?? 'user';
      const a = accessOf(name);
      if (data.resolution === 'deny') {
        // A stop or cancel sweeping a pending card is not a decision about the tool.
        if (HUMAN.has(by) || RULE.has(by)) a.denied++;
      } else if (HUMAN.has(by)) a.user++;
      else if (RULE.has(by) || data.auto) a.auto++;
      continue;
    }
    if (event.kind !== 'sdk') continue;
    const type = (event.data as { type?: string } | null)?.type;
    if (type !== 'assistant' && type !== 'user') continue;
    const blocks = contentOf(event.data);
    if (!blocks) continue;
    for (const b of blocks) {
      if (type === 'assistant' && b?.type === 'tool_use' && b.id && b.name && parseMcpToolName(b.name)) {
        calls.set(b.id, b.name);
      } else if (type === 'user' && b?.type === 'tool_result' && b.tool_use_id && b.is_error) {
        failed.add(b.tool_use_id);
      }
    }
  }

  const servers = new Map<string, McpUsage>();
  const tools = new Map<string, McpToolUsage>();
  for (const [id, name] of calls) {
    const { server, tool } = parseMcpToolName(name)!;
    let s = servers.get(server);
    if (!s) servers.set(server, (s = { server, calls: 0, errors: 0, tools: [] }));
    let t = tools.get(name);
    if (!t) {
      t = { tool, calls: 0, errors: 0, access: accessOf(name) };
      tools.set(name, t);
      s.tools.push(t);
    }
    const err = failed.has(id) ? 1 : 0;
    s.calls++;
    s.errors += err;
    t.calls++;
    t.errors += err;
  }
  for (const t of tools.values()) {
    const resolved = t.access.user + t.access.auto + t.access.denied;
    t.access.unprompted = Math.max(0, t.calls - resolved);
  }
  const out = [...servers.values()];
  for (const s of out) s.tools.sort((a, b) => b.calls - a.calls);
  return out.sort((a, b) => b.calls - a.calls);
}

/** Total MCP calls across servers. */
export function mcpCallCount(usage: readonly McpUsage[]): number {
  return usage.reduce((n, s) => n + s.calls, 0);
}
