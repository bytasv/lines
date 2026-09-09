/**
 * Vendors that run a hosted (remote) MCP server, used for two things and
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
 * path. Paths move and vary (`/mcp`, `/sse`, `/v1/sse`, `/mcp/v1/http`), and a
 * wrong path in here would either mislabel the real endpoint or invite the agent
 * to call a URL this file made up. The agent still has to read the vendor's own
 * documentation and cite it as `source` — this table only judges where the
 * answer landed.
 *
 * ## Failure direction
 *
 * A stale or wrong `endpointHosts` entry makes the vendor's *real* endpoint read
 * `suspicious` — a false alarm the user can approve past. It cannot make an
 * attacker's URL read `known` unless the attacker controls the host named here.
 * That asymmetry is deliberate: this table is allowed to be wrong in the
 * cautious direction only, and no level of it ever skips the approval card.
 *
 * ## Scope, and what is deliberately absent
 *
 * Only vendors with a *hosted* endpoint. A service whose MCP server is a local
 * process (MongoDB, Grafana, most databases) or is per-tenant with no stable
 * host (Shopify's per-store Storefront server) is left out on purpose: nudging
 * the agent toward a hosted URL that does not exist would send it hunting.
 *
 * Compiled 2026-09-08 from the vendor-run entries in
 * github.com/jaw9c/awesome-remote-mcp-servers and
 * github.com/sylviangth/awesome-remote-mcp-servers, plus vendor documentation
 * for Figma, Datadog, Twilio, Slack, GitLab and Snowflake. Adding a row is one
 * line; getting one wrong costs a false `suspicious`, per the note above.
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
  /**
   * False for a service whose content an ordinary fetch already reaches (public
   * repos, docs sites, Q&A). Those rows exist for the trust check only: nudging
   * on them would fire on half the prompts in a working session and recommend a
   * connection nobody needs. A login wall is what makes a nudge worth its tokens.
   */
  nudge: boolean;
}

/** `[name, vendor, hosts, endpointHosts, nudge?]`, hosts space-separated. */
type Row = readonly [string, string, string, string, boolean?];

/**
 * Rows, not object literals: at this length the shape is noise and the data is
 * the point. `MCP_DIRECTORY` below is the typed form every consumer reads.
 */
const ROWS: Row[] = [
  // ---- issue tracking, docs and project management ----
  ['linear', 'Linear', 'linear.app', 'mcp.linear.app'],
  ['atlassian', 'Atlassian (Jira and Confluence)', 'atlassian.net atlassian.com jira.com', 'mcp.atlassian.com'],
  ['notion', 'Notion', 'notion.so notion.com', 'mcp.notion.com'],
  ['asana', 'Asana', 'asana.com', 'mcp.asana.com'],
  ['monday', 'monday.com', 'monday.com', 'mcp.monday.com'],
  ['airtable', 'Airtable', 'airtable.com', 'mcp.airtable.com'],
  ['box', 'Box', 'box.com', 'mcp.box.com'],
  ['egnyte', 'Egnyte', 'egnyte.com', 'mcp-server.egnyte.com'],
  ['jam', 'Jam', 'jam.dev', 'mcp.jam.dev'],
  ['tally', 'Tally', 'tally.so', 'mcp.tally.so'],

  // ---- code hosting, CI and code intelligence ----
  ['github', 'GitHub', 'github.com', 'api.githubcopilot.com', false],
  ['gitlab', 'GitLab', 'gitlab.com', 'gitlab.com'],
  ['buildkite', 'Buildkite', 'buildkite.com', 'mcp.buildkite.com'],
  ['semgrep', 'Semgrep', 'semgrep.dev semgrep.ai', 'mcp.semgrep.ai'],
  ['deepwiki', 'DeepWiki', 'deepwiki.com', 'mcp.deepwiki.com', false],
  ['stackoverflow', 'Stack Overflow', 'stackoverflow.com', 'mcp.stackoverflow.com', false],
  ['openzeppelin', 'OpenZeppelin', 'openzeppelin.com', 'mcp.openzeppelin.com', false],
  ['astro', 'Astro', 'astro.build', 'mcp.docs.astro.build', false],

  // ---- observability, incidents and platform ----
  ['sentry', 'Sentry', 'sentry.io', 'mcp.sentry.dev'],
  ['datadog', 'Datadog', 'datadoghq.com datadoghq.eu', 'mcp.datadoghq.com mcp.datadoghq.eu'],
  ['polarsignals', 'Polar Signals', 'polarsignals.com', 'api.polarsignals.com'],
  ['port', 'Port', 'port.io', 'mcp.port.io'],
  ['cortex', 'Cortex', 'cortex.io', 'mcp.cortex.io'],
  ['globalping', 'Globalping', 'globalping.io globalping.dev', 'mcp.globalping.dev'],

  // ---- hosting, edge and databases ----
  ['vercel', 'Vercel', 'vercel.com', 'mcp.vercel.com'],
  ['netlify', 'Netlify', 'netlify.com', 'netlify-mcp.netlify.app'],
  ['cloudflare', 'Cloudflare', 'cloudflare.com', 'mcp.cloudflare.com'],
  ['supabase', 'Supabase', 'supabase.com supabase.co', 'mcp.supabase.com'],
  ['neon', 'Neon', 'neon.tech neon.com', 'mcp.neon.tech'],
  ['prisma', 'Prisma', 'prisma.io', 'mcp.prisma.io'],
  ['instantdb', 'InstantDB', 'instantdb.com', 'mcp.instantdb.com'],
  ['grafbase', 'Grafbase', 'grafbase.com', 'api.grafbase.com'],
  ['snowflake', 'Snowflake', 'snowflake.com snowflakecomputing.com', 'snowflakecomputing.com'],
  ['thoughtspot', 'ThoughtSpot', 'thoughtspot.com thoughtspot.app', 'agent.thoughtspot.app'],
  ['awsknowledge', 'AWS Knowledge', 'docs.aws.amazon.com', 'knowledge-mcp.global.api.aws', false],
  ['bigquery', 'Google BigQuery', 'bigquery.googleapis.com', 'bigquery.googleapis.com'],
  ['gke', 'Google Kubernetes Engine', 'container.googleapis.com', 'container.googleapis.com'],
  ['gce', 'Google Compute Engine', 'compute.googleapis.com', 'compute.googleapis.com'],
  ['googlemaps', 'Google Maps', 'mapstools.googleapis.com', 'mapstools.googleapis.com', false],

  // ---- design and content ----
  ['figma', 'Figma', 'figma.com', 'mcp.figma.com'],
  ['canva', 'Canva', 'canva.com', 'mcp.canva.com'],
  ['webflow', 'Webflow', 'webflow.com', 'mcp.webflow.com'],
  ['wix', 'Wix', 'wix.com', 'mcp.wix.com'],
  ['cloudinary', 'Cloudinary', 'cloudinary.com', 'mcp.cloudinary.com'],
  ['invideo', 'invideo', 'invideo.io', 'mcp.invideo.io'],
  ['resemble', 'Resemble AI', 'resemble.ai', 'mcp.resemble.ai'],

  // ---- payments, finance and commerce ----
  ['stripe', 'Stripe', 'stripe.com', 'mcp.stripe.com'],
  ['square', 'Square', 'squareup.com square.com', 'mcp.squareup.com'],
  ['paypal', 'PayPal', 'paypal.com', 'mcp.paypal.com'],
  ['plaid', 'Plaid', 'plaid.com', 'api.dashboard.plaid.com'],
  ['ramp', 'Ramp', 'ramp.com', 'ramp-mcp-remote.ramp.com'],
  ['dodopayments', 'Dodo Payments', 'dodopayments.com', 'mcp.dodopayments.com'],
  ['mercadolibre', 'Mercado Libre', 'mercadolibre.com', 'mcp.mercadolibre.com'],
  ['mercadopago', 'Mercado Pago', 'mercadopago.com', 'mcp.mercadopago.com'],
  ['morningstar', 'Morningstar', 'morningstar.com', 'mcp.morningstar.com'],
  ['octagon', 'Octagon', 'octagonagents.com', 'mcp.octagonagents.com'],

  // ---- CRM, support and communication ----
  ['slack', 'Slack', 'slack.com', 'mcp.slack.com'],
  ['intercom', 'Intercom', 'intercom.com', 'mcp.intercom.com'],
  ['hubspot', 'HubSpot', 'hubspot.com', 'app.hubspot.com'],
  ['attio', 'Attio', 'attio.com', 'mcp.attio.com'],
  ['close', 'Close', 'close.com', 'mcp.close.com'],
  ['twilio', 'Twilio', 'twilio.com', 'mcp.twilio.com'],
  ['telnyx', 'Telnyx', 'telnyx.com', 'api.telnyx.com'],
  ['stytch', 'Stytch', 'stytch.com stytch.dev', 'mcp.stytch.dev'],
  ['fireflies', 'Fireflies', 'fireflies.ai', 'api.fireflies.ai'],
  ['indeed', 'Indeed', 'indeed.com', 'mcp.indeed.com'],
  ['peek', 'Peek', 'peek.com', 'mcp.peek.com'],

  // ---- search, scraping and agent tooling ----
  ['exa', 'Exa', 'exa.ai', 'mcp.exa.ai', false],
  ['firecrawl', 'Firecrawl', 'firecrawl.dev', 'mcp.firecrawl.dev', false],
  ['apify', 'Apify', 'apify.com', 'mcp.apify.com'],
  ['simplescraper', 'Simplescraper', 'simplescraper.io', 'mcp.simplescraper.io'],
  ['searchapi', 'SearchAPI', 'searchapi.io', 'searchapi.io', false],
  ['dappier', 'Dappier', 'dappier.com', 'mcp.dappier.com', false],
  ['needle', 'Needle', 'needle-ai.com', 'mcp.needle-ai.com'],
  ['parallel', 'Parallel', 'parallel.ai', 'task-mcp.parallel.ai search-mcp.parallel.ai', false],
  ['wolfram', 'Wolfram', 'wolfram.com wolframalpha.com', 'agenttools.wolfram.com', false],
  ['huggingface', 'Hugging Face', 'huggingface.co hf.co', 'huggingface.co hf.co', false],
  ['malwarepatrol', 'Malware Patrol', 'malwarepatrol.net', 'mcp.malwarepatrol.net'],
  ['shortio', 'Short.io', 'short.io', 'ai-assistant.short.io'],

  // ---- automation hubs (one connection, many downstream apps) ----
  ['zapier', 'Zapier', 'zapier.com', 'mcp.zapier.com'],
  ['composio', 'Composio', 'composio.dev', 'mcp.composio.dev'],
  ['pipedream', 'Pipedream', 'pipedream.com', 'mcp.pipedream.com'],
  ['rube', 'Rube', 'rube.app', 'rube.app'],
  ['waystation', 'WayStation', 'waystation.ai', 'waystation.ai'],
];

export const MCP_DIRECTORY: McpDirectoryEntry[] = ROWS.map(
  ([name, vendor, hosts, endpointHosts, nudge]) => ({
    name,
    vendor,
    hosts: hosts.split(' '),
    endpointHosts: endpointHosts.split(' '),
    nudge: nudge !== false,
  }),
);

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
  const missing = servicesNamedIn(text)
    .filter((entry) => entry.nudge)
    .filter((entry) => !connections.some((c) => covers(c, entry)));
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
