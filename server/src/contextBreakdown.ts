/**
 * Projection of the SDK's `SDKControlGetContextUsageResponse` (the data behind
 * the CLI's `/context` command) into our two shapes: the ephemeral
 * `ContextBreakdown` sent to the browser, and the small `ContextSummary`
 * persisted on the session meta.
 *
 * Pure and total: this runs on data we don't own, so a malformed or older-CLI
 * payload yields undefined or empty arrays rather than throwing.
 */
import type { ContextBreakdown, ContextCategory, ContextSummary } from '@lines/shared';

/** Non-finite/non-numeric becomes 0 — never NaN downstream. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v ? v : fallback;
}

function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];
}

/**
 * Comparison key for a category name: lowercased, trimmed, with a trailing
 * ` (deferred)` stripped. Used for both the free-space filter and the UI's
 * colour/detail matching, so a CLI rename degrades instead of breaking.
 */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s*\(deferred\)$/, '');
}

/** Sum of the rows that count against the window — the deferred ones don't. */
export function sumNonDeferred(categories: ContextCategory[]): number {
  return categories.reduce((total, c) => (c.deferred ? total : total + c.tokens), 0);
}

/** MCP tools regrouped by server: first-seen server order, tools by size desc. */
function groupMcpTools(raw: unknown): ContextBreakdown['mcpServers'] {
  const byServer = new Map<string, ContextBreakdown['mcpServers'][number]>();
  for (const tool of arr(raw)) {
    const serverName = str(tool.serverName, '(unknown)');
    let entry = byServer.get(serverName);
    if (!entry) {
      entry = { serverName, tokens: 0, toolCount: 0, tools: [] };
      byServer.set(serverName, entry);
    }
    const tokens = num(tool.tokens);
    entry.tokens += tokens;
    entry.toolCount += 1;
    entry.tools.push({
      name: str(tool.name, '(unnamed)'),
      tokens,
      ...(typeof tool.isLoaded === 'boolean' ? { loaded: tool.isLoaded } : {}),
    });
  }
  for (const entry of byServer.values()) entry.tools.sort((a, b) => b.tokens - a.tokens);
  return [...byServer.values()];
}

function namedTokens(raw: unknown): { name: string; tokens: number }[] {
  return arr(raw).map((x) => ({ name: str(x.name, '(unnamed)'), tokens: num(x.tokens) }));
}

/**
 * Normalize a raw control-request response. Returns undefined unless it carries
 * the two fields everything else is derived from — a numeric window and a
 * category list; every other field is optional, since older CLIs omit whole
 * sections.
 */
export function normalizeContextBreakdown(raw: unknown, at: number): ContextBreakdown | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.maxTokens !== 'number' || !Number.isFinite(r.maxTokens)) return undefined;
  if (!Array.isArray(r.categories)) return undefined;

  // Order is preserved: the CLI orders categories meaningfully (largest concerns
  // first, free space last). `color` is dropped — those are CLI theme tokens.
  const categories: ContextCategory[] = arr(r.categories).map((c) => ({
    name: str(c.name, 'Unknown'),
    tokens: num(c.tokens),
    ...(c.isDeferred === true ? { deferred: true as const } : {}),
  }));

  const skillsRaw = r.skills as Record<string, unknown> | undefined;
  const commandsRaw = r.slashCommands as Record<string, unknown> | undefined;
  const messagesRaw = r.messageBreakdown as Record<string, unknown> | undefined;

  return {
    at,
    model: str(r.model, ''),
    totalTokens: num(r.totalTokens),
    maxTokens: r.maxTokens,
    ...(typeof r.rawMaxTokens === 'number' && Number.isFinite(r.rawMaxTokens)
      ? { rawMaxTokens: r.rawMaxTokens }
      : {}),
    percentage: num(r.percentage),
    categories,
    ...(typeof r.autoCompactThreshold === 'number' && Number.isFinite(r.autoCompactThreshold)
      ? { autoCompactThreshold: r.autoCompactThreshold }
      : {}),
    ...(typeof r.isAutoCompactEnabled === 'boolean' ? { isAutoCompactEnabled: r.isAutoCompactEnabled } : {}),
    mcpServers: groupMcpTools(r.mcpTools),
    memoryFiles: arr(r.memoryFiles).map((f) => ({
      path: str(f.path, ''),
      type: str(f.type, ''),
      tokens: num(f.tokens),
    })),
    agents: arr(r.agents).map((a) => ({
      agentType: str(a.agentType, '(unnamed)'),
      source: str(a.source, ''),
      tokens: num(a.tokens),
    })),
    systemTools: namedTokens(r.systemTools),
    systemPromptSections: namedTokens(r.systemPromptSections),
    deferredTools: arr(r.deferredBuiltinTools).map((t) => ({
      name: str(t.name, '(unnamed)'),
      tokens: num(t.tokens),
      ...(typeof t.isLoaded === 'boolean' ? { loaded: t.isLoaded } : {}),
    })),
    ...(skillsRaw
      ? {
          skills: {
            total: num(skillsRaw.totalSkills),
            included: num(skillsRaw.includedSkills),
            tokens: num(skillsRaw.tokens),
            items: arr(skillsRaw.skillFrontmatter).map((s) => ({
              name: str(s.name, '(unnamed)'),
              source: str(s.source, ''),
              tokens: num(s.tokens),
            })),
          },
        }
      : {}),
    ...(commandsRaw
      ? {
          slashCommands: {
            total: num(commandsRaw.totalCommands),
            included: num(commandsRaw.includedCommands),
            tokens: num(commandsRaw.tokens),
          },
        }
      : {}),
    ...(messagesRaw
      ? {
          messages: {
            toolCalls: num(messagesRaw.toolCallTokens),
            toolResults: num(messagesRaw.toolResultTokens),
            attachments: num(messagesRaw.attachmentTokens),
            assistant: num(messagesRaw.assistantMessageTokens),
            user: num(messagesRaw.userMessageTokens),
            other: num(messagesRaw.redirectedContextTokens) + num(messagesRaw.unattributedTokens),
          },
        }
      : {}),
  };
}

/** Defensive cap: the meta is persisted and synced, so an unexpectedly chatty
 *  future CLI must not be able to grow it without bound. */
const MAX_SUMMARY_ROWS = 16;

/**
 * Strip the breakdown to what is safe to persist on SessionMeta: no per-item
 * detail, no empty rows, and no free-space row (the UI derives it from
 * maxTokens - totalTokens). Deferred rows are kept — there are few and they
 * explain an otherwise puzzling gap.
 */
export function summarizeContextBreakdown(full: ContextBreakdown): ContextSummary {
  const categories = full.categories
    .filter((c) => c.tokens > 0 && normalizeName(c.name) !== 'free space')
    .slice(0, MAX_SUMMARY_ROWS);
  return {
    at: full.at,
    model: full.model,
    totalTokens: full.totalTokens,
    maxTokens: full.maxTokens,
    ...(full.rawMaxTokens !== undefined ? { rawMaxTokens: full.rawMaxTokens } : {}),
    percentage: full.percentage,
    categories,
    ...(full.autoCompactThreshold !== undefined ? { autoCompactThreshold: full.autoCompactThreshold } : {}),
    ...(full.isAutoCompactEnabled !== undefined ? { isAutoCompactEnabled: full.isAutoCompactEnabled } : {}),
  };
}

/**
 * Equality ignoring `at`. Gates the meta upsert so a hover-triggered refresh of
 * unchanged numbers doesn't broadcast a sessionUpsert and push to storage sync.
 */
export function sameContextSummary(a?: ContextSummary, b?: ContextSummary): boolean {
  if (!a || !b) return !a && !b;
  return JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 });
}
