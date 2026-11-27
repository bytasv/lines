/**
 * Readable names for MCP tool calls. Both engines name an MCP tool
 * `mcp__<server>__<tool>` (shared/codex.ts maps Codex calls onto the same
 * scheme), which is accurate and unreadable; this turns it into a provider
 * ("Linear") and a tool ("Create issue") the transcript and the context popover
 * can show, keeping the raw name for a tooltip.
 *
 * Pure, and free of React and icon imports, so the server's test runner can load
 * it: the logo glyph is named by `icon`, and McpToolLabel maps the name to a
 * component.
 */

export interface McpToolName {
  server: string;
  tool: string;
}

/**
 * Splits `mcp__<server>__<tool>`. The server ends at the first `__` after the
 * prefix, so a tool name may itself hold `__`; a server name holding `__` (the
 * connection validator allows it, the CLI's own configs too) mis-splits, which
 * only costs readability. Null for anything that isn't an MCP tool.
 */
export function parseMcpToolName(name: string): McpToolName | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5);
  const at = rest.indexOf('__');
  if (at <= 0 || at + 2 >= rest.length) return null;
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

/** `get_runtime_logs`, `get-runtime-logs`, `getRuntimeLogs` all read `Get runtime logs`. */
export function humanizeToolName(tool: string): string {
  const words = tool
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // `HTTPStatus` splits before `Status`; a plural acronym (`PRs`) stays whole.
    .replace(/([A-Z]+)([A-Z](?!s\b)[a-z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean);
  if (words.length === 0) return tool;
  const lower = words.map((w) => (/^[A-Z0-9]{2,}s?$/.test(w) ? w : w.toLowerCase()));
  const sentence = lower.join(' ');
  return sentence[0].toUpperCase() + sentence.slice(1);
}

/** Logo glyph names McpToolLabel knows; anything else renders a monogram. */
export type McpIconKey =
  | 'airtable'
  | 'asana'
  | 'aws'
  | 'cloudflare'
  | 'figma'
  | 'github'
  | 'gitlab'
  | 'google'
  | 'intercom'
  | 'jira'
  | 'lines'
  | 'mongodb'
  | 'notion'
  | 'openai'
  | 'paypal'
  | 'prisma'
  | 'sentry'
  | 'slack'
  | 'stripe'
  | 'supabase'
  | 'trello'
  | 'twilio'
  | 'vercel'
  | 'webflow'
  | 'zapier';

export interface McpProvider {
  /** Server name as the CLI reports it: the grouping key. */
  server: string;
  label: string;
  icon?: McpIconKey;
  /** CSS colour for the tile. */
  color: string;
  /** One or two letters, for a tile with no glyph. */
  monogram: string;
}

/**
 * Known providers, keyed by lowercased server name. Labels mirror the `vendor`
 * column of server/src/mcpDirectory.ts for the vendors listed there (kept as a
 * small web-side copy: web never imports server code). No favicon fetch for the
 * rest — that would tell a third party which services the user works with.
 */
const BRANDS: Record<string, { label: string; icon?: McpIconKey; color: string }> = {
  lines: { label: 'Lines', icon: 'lines', color: '#1f2328' },
  linear: { label: 'Linear', color: '#5e6ad2' },
  atlassian: { label: 'Atlassian', icon: 'jira', color: '#0052cc' },
  jira: { label: 'Jira', icon: 'jira', color: '#0052cc' },
  notion: { label: 'Notion', icon: 'notion', color: '#1f1f1f' },
  asana: { label: 'Asana', icon: 'asana', color: '#f06a6a' },
  airtable: { label: 'Airtable', icon: 'airtable', color: '#18bfff' },
  trello: { label: 'Trello', icon: 'trello', color: '#0079bf' },
  github: { label: 'GitHub', icon: 'github', color: '#1f2328' },
  gitlab: { label: 'GitLab', icon: 'gitlab', color: '#fc6d26' },
  sentry: { label: 'Sentry', icon: 'sentry', color: '#362d59' },
  datadog: { label: 'Datadog', color: '#632ca6' },
  vercel: { label: 'Vercel', icon: 'vercel', color: '#000000' },
  netlify: { label: 'Netlify', color: '#00ad9f' },
  cloudflare: { label: 'Cloudflare', icon: 'cloudflare', color: '#f38020' },
  supabase: { label: 'Supabase', icon: 'supabase', color: '#3ecf8e' },
  neon: { label: 'Neon', color: '#00e599' },
  prisma: { label: 'Prisma', icon: 'prisma', color: '#2d3748' },
  mongodb: { label: 'MongoDB', icon: 'mongodb', color: '#47a248' },
  awsknowledge: { label: 'AWS Knowledge', icon: 'aws', color: '#ff9900' },
  bigquery: { label: 'Google BigQuery', icon: 'google', color: '#4285f4' },
  googlemaps: { label: 'Google Maps', icon: 'google', color: '#4285f4' },
  figma: { label: 'Figma', icon: 'figma', color: '#a259ff' },
  canva: { label: 'Canva', color: '#00c4cc' },
  webflow: { label: 'Webflow', icon: 'webflow', color: '#4353ff' },
  stripe: { label: 'Stripe', icon: 'stripe', color: '#635bff' },
  paypal: { label: 'PayPal', icon: 'paypal', color: '#003087' },
  slack: { label: 'Slack', icon: 'slack', color: '#4a154b' },
  intercom: { label: 'Intercom', icon: 'intercom', color: '#1f8ded' },
  hubspot: { label: 'HubSpot', color: '#ff7a59' },
  twilio: { label: 'Twilio', icon: 'twilio', color: '#f22f46' },
  zapier: { label: 'Zapier', icon: 'zapier', color: '#ff4f00' },
  openai: { label: 'OpenAI', icon: 'openai', color: '#10a37f' },
  playwright: { label: 'Playwright', color: '#2ead33' },
  pencil: { label: 'Pencil', color: '#f59f00' },
  context7: { label: 'Context7', color: '#0f766e' },
};

/** Prefixes connectors carry in front of the vendor's own name (`claude_ai_Linear`). */
const CONNECTOR_PREFIXES = [/^claude_ai_/i, /^claude-ai-/i];

function brandKey(server: string): string {
  let key = server;
  for (const re of CONNECTOR_PREFIXES) key = key.replace(re, '');
  return key.toLowerCase();
}

/** `my_tracker` reads `My tracker`; a connector prefix is dropped first. */
function fallbackLabel(server: string): string {
  let key = server;
  for (const re of CONNECTOR_PREFIXES) key = key.replace(re, '');
  return humanizeToolName(key || server);
}

/** A stable hue per name, so an unknown provider keeps its colour across renders and sessions. */
function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}

function monogramOf(label: string): string {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (label[0] ?? '?').toUpperCase();
}

const providerCache = new Map<string, McpProvider>();

/** How one MCP server is shown: label, logo glyph or monogram, and tile colour. */
export function mcpProvider(server: string): McpProvider {
  const cached = providerCache.get(server);
  if (cached) return cached;
  const brand = BRANDS[brandKey(server)];
  const label = brand?.label ?? fallbackLabel(server);
  const provider: McpProvider = {
    server,
    label,
    icon: brand?.icon,
    color: brand?.color ?? hashColor(brandKey(server)),
    monogram: monogramOf(label),
  };
  providerCache.set(server, provider);
  return provider;
}

/** `Linear · Create issue` for an MCP tool name; null for anything else. */
export function mcpToolTitle(name: string): string | null {
  const parsed = parseMcpToolName(name);
  if (!parsed) return null;
  return `${mcpProvider(parsed.server).label} · ${humanizeToolName(parsed.tool)}`;
}

/** The grouping key for a tally: the server for an MCP tool, the tool name otherwise. */
export function mcpGroupKey(name: string): { key: string; server?: string; label: string } {
  const parsed = parseMcpToolName(name);
  if (!parsed) return { key: name, label: name };
  return { key: `mcp:${parsed.server}`, server: parsed.server, label: mcpProvider(parsed.server).label };
}
