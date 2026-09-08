/**
 * Well-known vendors that publish a hosted MCP server, used for two things and
 * nothing else:
 *
 *  1. **A prompt-scoped nudge.** When the user's own prompt names a service they
 *     have no connection for, one line is appended to *that turn's* prompt (see
 *     `SessionManager.prompt`) telling the agent it has no tools for it and can
 *     propose one. It fires on the user naming the service and never otherwise,
 *     so a session that talks about nothing in this table costs zero tokens.
 *  2. **A deterministic half of the trust check** (see mcpVetting.ts): a proposal
 *     whose URL sits on the vendor's documented MCP host reads `known` with no
 *     model call, and one that claims a vendor's name from somewhere else reads
 *     `suspicious`.
 *
 * ## Why hosts and not URLs
 *
 * Entries carry the *host* an endpoint is documented to live on, never a full
 * path. Paths move (`/mcp`, `/v1/sse`, `/mcp/`), and a wrong path in here would
 * either mislabel the real endpoint or, worse, invite the agent to call a URL
 * this file made up. The agent still has to read the vendor's own documentation
 * and cite it as `source` — this table only judges where the answer landed.
 *
 * ## Failure direction
 *
 * A stale or wrong `endpointHosts` entry makes the vendor's *real* endpoint read
 * `suspicious` — a false alarm the user can approve past. It cannot make an
 * attacker's URL read `known` unless the attacker controls the host named here.
 * That asymmetry is deliberate: this table is allowed to be wrong in the
 * cautious direction only, and no level of it ever skips the approval card.
 */

export interface McpDirectoryEntry {
  /** Suggested MCP namespace, and the name an agent proposal is matched against. */
  name: string;
  /** How the vendor is written in prose, for the nudge and the badge copy. */
  vendor: string;
  /**
   * Hosts that mean the user is talking about this service. Every one carries a
   * TLD on purpose, so prose ("linear algebra", "a notion of scope") cannot match.
   */
  hosts: string[];
  /** Hosts the vendor documents its MCP endpoint on. Subdomains count as a match. */
  endpointHosts: string[];
}

/**
 * Deliberately short. An entry earns its place by being a service whose hosted
 * MCP server is documented by the vendor itself; anything else is left to the
 * judge query, which is the path every unlisted vendor takes anyway.
 */
export const MCP_DIRECTORY: McpDirectoryEntry[] = [
  {
    name: 'linear',
    vendor: 'Linear',
    hosts: ['linear.app'],
    endpointHosts: ['mcp.linear.app'],
  },
  {
    name: 'sentry',
    vendor: 'Sentry',
    hosts: ['sentry.io'],
    endpointHosts: ['mcp.sentry.dev'],
  },
  {
    name: 'notion',
    vendor: 'Notion',
    hosts: ['notion.so', 'notion.com'],
    endpointHosts: ['mcp.notion.com'],
  },
  {
    name: 'figma',
    vendor: 'Figma',
    hosts: ['figma.com'],
    endpointHosts: ['mcp.figma.com'],
  },
  {
    name: 'atlassian',
    vendor: 'Atlassian (Jira and Confluence)',
    hosts: ['atlassian.net', 'atlassian.com'],
    endpointHosts: ['mcp.atlassian.com'],
  },
  {
    name: 'github',
    vendor: 'GitHub',
    hosts: ['github.com'],
    endpointHosts: ['api.githubcopilot.com'],
  },
  {
    name: 'stripe',
    vendor: 'Stripe',
    hosts: ['stripe.com'],
    endpointHosts: ['mcp.stripe.com'],
  },
  {
    name: 'vercel',
    vendor: 'Vercel',
    hosts: ['vercel.com'],
    endpointHosts: ['mcp.vercel.com'],
  },
  {
    name: 'supabase',
    vendor: 'Supabase',
    hosts: ['supabase.com', 'supabase.co'],
    endpointHosts: ['mcp.supabase.com'],
  },
  {
    name: 'cloudflare',
    vendor: 'Cloudflare',
    hosts: ['cloudflare.com'],
    endpointHosts: ['mcp.cloudflare.com'],
  },
  {
    name: 'asana',
    vendor: 'Asana',
    hosts: ['asana.com'],
    endpointHosts: ['mcp.asana.com'],
  },
  {
    name: 'canva',
    vendor: 'Canva',
    hosts: ['canva.com'],
    endpointHosts: ['mcp.canva.com'],
  },
  {
    name: 'huggingface',
    vendor: 'Hugging Face',
    hosts: ['huggingface.co'],
    endpointHosts: ['huggingface.co'],
  },
];

/** `sub.mcp.linear.app` counts as `mcp.linear.app`; `notmcp.linear.app` does not. */
export function hostMatches(host: string, candidate: string): boolean {
  const h = host.toLowerCase();
  const c = candidate.toLowerCase();
  return h === c || h.endsWith(`.${c}`);
}

/** The entry a proposed namespace or endpoint host belongs to, if any. */
export function directoryEntryFor(opts: { name?: string; host?: string }): McpDirectoryEntry | undefined {
  const name = opts.name?.trim().toLowerCase();
  const host = opts.host?.trim().toLowerCase();
  return MCP_DIRECTORY.find(
    (entry) =>
      (name !== undefined && name !== '' && entry.name === name) ||
      (host !== undefined && host !== '' && entry.endpointHosts.some((e) => hostMatches(host, e))),
  );
}

/**
 * Services this text names by domain. Matching is on a host with its TLD, with
 * both neighbours checked, so `linear.app` matches in a URL, in `@linear.app`
 * and in bare prose, but `mylinear.app.example` and `linear.apple` do not.
 */
export function servicesNamedIn(text: string): McpDirectoryEntry[] {
  const haystack = text.toLowerCase();
  const found: McpDirectoryEntry[] = [];
  for (const entry of MCP_DIRECTORY) {
    if (entry.hosts.some((host) => mentionsHost(haystack, host))) found.push(entry);
  }
  return found;
}

function mentionsHost(haystack: string, host: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(host, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : haystack[at - 1];
    const after = haystack[at + host.length] ?? '';
    // A leading dot is a subdomain of the same service (`app.linear.app`); a
    // leading word character means a different domain that merely ends the same
    // way (`notlinear.app`). A trailing word character or dot means the host is a
    // prefix of a longer one (`linear.apple.com`).
    const leftOk = before === '' || before === '.' || !/[a-z0-9-]/.test(before);
    const rightOk = after === '' || !/[a-z0-9.-]/.test(after);
    if (leftOk && rightOk) return true;
    from = at + host.length;
  }
}

/** What an existing connection covers, for suppressing a nudge about it. */
export interface CoveredConnection {
  name: string;
  url?: string;
  enabled: boolean;
}

/** True when this connection already serves that vendor, by namespace or by host. */
function covers(connection: CoveredConnection, entry: McpDirectoryEntry): boolean {
  if (!connection.enabled) return false;
  if (connection.name.toLowerCase() === entry.name) return true;
  if (!connection.url) return false;
  try {
    const host = new URL(connection.url).hostname;
    return entry.endpointHosts.some((e) => hostMatches(host, e)) || entry.hosts.some((h) => hostMatches(host, h));
  } catch {
    return false;
  }
}

/** How many vendors one hint will name, so a prompt listing five services stays short. */
const HINT_MAX_SERVICES = 2;

/**
 * The line to append to this turn's prompt, or null when there is nothing to
 * say — which is the overwhelmingly common case, and the reason this lives on
 * the prompt rather than in the system prompt: an unmatched turn pays nothing,
 * and a matched one pays once without restarting the query.
 *
 * Never mentions a URL: the agent has to read the vendor's documentation and
 * cite it, because that citation is what the user is shown on the approval card.
 */
export function mcpConnectionHint(text: string, connections: CoveredConnection[]): string | null {
  const missing = servicesNamedIn(text).filter((entry) => !connections.some((c) => covers(c, entry)));
  if (!missing.length) return null;
  const named = missing.slice(0, HINT_MAX_SERVICES);
  const vendors = named.map((e) => e.vendor).join(' and ');
  const which = named.length === 1 ? 'it' : 'them';
  return (
    `<lines-mcp-hint>This session has no MCP connection for ${vendors}, so you have no ${vendors} ` +
    `tools. If the task needs data from ${which}, do not ask the user to paste it and do not settle for ` +
    `fetching a sign-in page: find the vendor's documented MCP endpoint, propose it with ` +
    `mcp__lines__add_mcp_connection (citing that documentation page as \`source\`, which the user sees ` +
    `on the approval card), then call mcp__lines__authorize_mcp_connection. Ignore this if the task does ` +
    `not need ${which}.</lines-mcp-hint>`
  );
}
