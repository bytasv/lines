/**
 * Is this MCP endpoint plausibly the vendor's own?
 *
 * The agent can propose a connection (`add_mcp_connection`), and the URL it
 * proposes may have come from a page it read — which makes prompt injection the
 * headline risk of that feature. The approval card is the defence; this module
 * exists so the user is deciding against a signal instead of a bare domain.
 *
 * Two stages, cheap first:
 *
 *  1. `deterministicVerdict` — plain code. A non-https URL, an IP-literal host,
 *     userinfo in the URL, a punycode/homograph host or a credential in the
 *     query string is `suspicious` without asking a model anything.
 *  2. A one-shot judge query, injected as `judge` rather than built here: the
 *     caller owns the query stack (see `SessionManager`), and injecting it keeps
 *     this module testable without a model and free of an import cycle.
 *
 * The judge is deliberately tool-free — the caller's options are `allowedTools:
 * []`, `maxTurns: 1` — **which is the security property**: it cannot fetch the
 * candidate page, so the page cannot talk it into trusting itself. It reasons
 * from the domain, the claimed vendor and its own knowledge.
 *
 * Best-effort throughout, following the same rule as the bridge's other helper
 * queries: no token, a timeout or a throw yields `unknown` rather than failing
 * the tool call or blocking the card.
 */
import type { McpVetting } from '@lines/shared';
import { directoryEntryFor, hostMatches } from './mcpDirectory.ts';

export interface McpVettingInput {
  /** The MCP namespace the agent wants to install it under. */
  name: string;
  url: string;
  /** Where the agent said it found the endpoint (a documentation URL). */
  source?: string;
}

/**
 * A one-shot model answer, or null when there is no usable one. Injected so this
 * module never imports the query stack.
 */
export type McpVettingJudge = (prompt: string, systemPrompt: string) => Promise<string | null>;

/** Its own constant, next to `consolidateTimeoutMs` in spirit: the card waits on this. */
export const VETTING_TIMEOUT_MS = 10_000;

export const VETTING_SYSTEM_PROMPT =
  'You assess whether an MCP server URL plausibly belongs to the vendor it claims to be. ' +
  'You have no tools and must not ask for any — reason only from the domain, the claimed ' +
  'name and your own knowledge. You never ask questions and never refuse. You reply with ' +
  'exactly one line in the form "LEVEL: reason", where LEVEL is known, unknown or suspicious.';

/** Local/loopback and IP-literal hosts, which no vendor's documented MCP endpoint is. */
const IP_LITERAL_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[|^\d+$/;
/** A punycode label — the homograph carrier. */
const PUNYCODE_RE = /(^|\.)xn--/i;
/** Query parameter names that would put a credential in a synced, transcribed URL. */
const CREDENTIAL_PARAMS = ['token', 'access_token', 'api_key', 'apikey', 'key', 'secret', 'password'];

/**
 * The verdict code alone can reach, or null when the URL passes every mechanical
 * check and only a judgement about the domain is left.
 */
export function deterministicVerdict(input: McpVettingInput): McpVetting | null {
  const suspicious = (reason: string): McpVetting => ({
    level: 'suspicious',
    reason,
    ...(input.source ? { source: input.source } : {}),
  });

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return suspicious('That is not a URL Lines can parse.');
  }
  if (parsed.protocol !== 'https:') {
    return suspicious('Not HTTPS — the tokens and tool traffic would travel in the clear.');
  }
  if (parsed.username || parsed.password) {
    return suspicious('The URL embeds credentials before the host, which a real endpoint does not.');
  }
  if (IP_LITERAL_RE.test(parsed.hostname)) {
    return suspicious('The host is a bare IP address, not a vendor domain.');
  }
  if (PUNYCODE_RE.test(parsed.hostname)) {
    return suspicious('The host uses a punycode label, which can imitate another domain.');
  }
  for (const param of parsed.searchParams.keys()) {
    if (CREDENTIAL_PARAMS.includes(param.toLowerCase())) {
      return suspicious(`The URL carries a credential in the query string (${param}).`);
    }
  }

  // The directory's two rulings, both cheaper and steadier than the judge for the
  // vendors it covers (see mcpDirectory.ts for why it stores hosts, not URLs).
  const entry = directoryEntryFor({ name: input.name, host: parsed.hostname });
  if (entry) {
    const onDocumentedHost = entry.endpointHosts.some((host) => hostMatches(parsed.hostname, host));
    if (onDocumentedHost) {
      return {
        level: 'known',
        reason: `${parsed.hostname} is ${entry.vendor}'s documented MCP host.`,
        ...(input.source ? { source: input.source } : {}),
      };
    }
    // Claims a vendor Lines knows, from a host that vendor does not serve MCP
    // from — the typosquat shape, and the one case worth calling out by name.
    return suspicious(
      `${entry.vendor} documents its MCP endpoint on ${entry.endpointHosts.join(' or ')}, not on ${parsed.hostname}.`,
    );
  }
  return null;
}

/** The prompt the judge answers. Kept next to the parser that reads its reply. */
export function vettingPrompt(input: McpVettingInput): string {
  return (
    'An AI agent proposes adding this MCP server to a developer\'s machine. Judge only ' +
    'whether the URL plausibly belongs to the vendor implied by the name.\n\n' +
    `Proposed name: ${input.name}\n` +
    `URL: ${input.url}\n` +
    `Cited source: ${input.source || '(none given)'}\n\n` +
    'Answer with one line, "LEVEL: reason":\n' +
    '- known — you recognise this as the vendor\'s own documented MCP endpoint.\n' +
    '- unknown — you cannot place it either way (an obscure vendor belongs here).\n' +
    '- suspicious — the domain looks like a typosquat, an imitation, or unrelated to the name.\n' +
    'Keep the reason under 20 words.'
  );
}

/**
 * The judge's one line as a verdict, or null when nothing parseable came back.
 * Tolerant of a chatty answer: the level is matched anywhere in the reply, since
 * a model that prefixes "Here is my assessment" is still reporting a level.
 */
export function parseVerdict(raw: string | null): McpVetting | null {
  if (!raw) return null;
  const match = /\b(known|unknown|suspicious)\b\s*[:\-—]\s*(.*)/i.exec(raw);
  if (!match) return null;
  const level = match[1].toLowerCase() as McpVetting['level'];
  const reason = match[2].split('\n')[0].trim().slice(0, 200);
  return { level, reason: reason || 'No reason given.' };
}

/** What every failure path answers: honest about having not checked. */
const UNCHECKED: McpVetting = { level: 'unknown', reason: 'Could not be checked.' };

/**
 * Assess one proposed endpoint. Never throws and never blocks the card: the
 * judge is raced against `VETTING_TIMEOUT_MS` and any failure reads `unknown`.
 */
export async function vetMcpUrl(
  input: McpVettingInput,
  judge?: McpVettingJudge,
  /** Overridable so a test can assert the bound without waiting the real one. */
  timeoutMs = VETTING_TIMEOUT_MS,
): Promise<McpVetting> {
  const withSource = (verdict: McpVetting): McpVetting => ({
    ...verdict,
    ...(input.source ? { source: input.source } : {}),
  });

  const mechanical = deterministicVerdict(input);
  if (mechanical) return mechanical;
  if (!judge) return withSource(UNCHECKED);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = Symbol('vetting-timeout');
    const answer = await Promise.race([
      judge(vettingPrompt(input), VETTING_SYSTEM_PROMPT),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (answer === timedOut) {
      // The abandoned query keeps draining in the background; nothing reads it.
      console.warn(`[mcp-vetting] timed out after ${timeoutMs}ms`);
      return withSource(UNCHECKED);
    }
    return withSource(parseVerdict(answer) ?? UNCHECKED);
  } catch (err) {
    console.warn('[mcp-vetting]', err);
    return withSource(UNCHECKED);
  } finally {
    clearTimeout(timer);
  }
}
