/**
 * What each provider's engine can actually do.
 *
 * P1 answered that question with an ad-hoc `providerForModel(...) === 'openai'`
 * at every site that cared — the composer, the transcript, the queue, the context
 * chip, `sessions.ts`, `workflows.ts`. That works at one or two sites and rots at
 * six: the checks drift, nobody can list what a provider supports, and every new
 * capability means finding them all again.
 *
 * So the question is answered once, here, and the call sites ask about a
 * *capability* rather than about a vendor. A site that reads `caps.interject`
 * keeps working when a third provider arrives, or when codex gains steering;
 * a site that reads `=== 'openai'` does not.
 *
 * The table describes the engine as currently wired, not the vendor's ceiling:
 * the flags move as the integration does, and flipping one is how a capability
 * ships.
 */
import type { ModelProvider } from './types.ts';

export interface ProviderCapabilities {
  /** Token-level deltas reach the transcript while the turn runs. */
  streaming: boolean;
  /** Tool calls can be gated on a permission card. */
  approvals: boolean;
  /** Plan mode is a real gate, not merely a read-only sandbox. */
  planMode: boolean;
  /** A queued prompt can be delivered into a turn already running ("Send now"). */
  interject: boolean;
  /** The conversation can be compacted. */
  compact: boolean;
  /** The session reports context occupancy, so the ring has a denominator. */
  contextWindow: boolean;
  /** The transcript can be truncated and the conversation re-pointed at it. */
  rewind: boolean;
  /** Lines' own workflow tools are hosted inside the session. */
  linesTools: boolean;
  /** The user's MCP connections apply to the session. */
  mcpConnections: boolean;
  /** Turns report a USD cost, not just tokens. */
  cost: boolean;
}

const ANTHROPIC: ProviderCapabilities = {
  streaming: true,
  approvals: true,
  planMode: true,
  interject: true,
  compact: true,
  contextWindow: true,
  rewind: true,
  linesTools: true,
  mcpConnections: true,
  cost: true,
};

/**
 * Codex over the app-server transport.
 *
 * `approvals` is on: codex asks before it acts, and the request is routed back
 * into the same permission card, auto-guard and allowlist a Claude call goes
 * through. `planMode` rides with it — plan mode is a read-only sandbox *plus* a
 * gate, and the gate is what was missing.
 *
 * `linesTools` is the one still false, and it is a capability Lines has not wired
 * rather than one codex lacks: the workflow tools are hosted in-process for the
 * Claude SDK, and codex can only reach them through a real MCP server.
 *
 * `cost` is the exception — false because codex genuinely reports tokens and
 * never a price, so it stays false on a subscription login.
 *
 * Workflow steps run on either provider, with one rule the Claude-only era never
 * needed: a step that changes provider cannot inherit the previous step's
 * conversation — see `providerSwitchNeedsFreshStart`. That is a property of the
 * *pair* of steps, not of a provider, so it is a function rather than a flag here.
 *
 * `mcpConnections` is on, but covers a narrower set of connections than the
 * Claude path: codex expresses a stdio server fully, an HTTP server whose only
 * credential is a bearer token, and nothing else. A connection it cannot
 * express is reported to the user rather than dropped — see
 * `McpConnections.codexServerConfigs`.
 */
const OPENAI: ProviderCapabilities = {
  streaming: true,
  approvals: true,
  planMode: true,
  interject: true,
  compact: true,
  contextWindow: true,
  rewind: true,
  linesTools: false,
  mcpConnections: true,
  cost: false,
};

const TABLE: Record<ModelProvider, ProviderCapabilities> = {
  anthropic: ANTHROPIC,
  openai: OPENAI,
};

export function capabilitiesFor(provider: ModelProvider): ProviderCapabilities {
  return TABLE[provider];
}

/**
 * Capabilities of the provider a model runs on. The common form, since provider
 * is always derived from `meta.model` and never stored.
 */
export function capabilitiesForModel(
  modelId: string,
  providerOf: (id: string) => ModelProvider,
): ProviderCapabilities {
  return capabilitiesFor(providerOf(modelId));
}

/**
 * Does moving from one provider to another have to start a fresh conversation?
 *
 * Always, and it is not a policy choice: nothing carries context between a
 * `claudeSessionId` and a `codexThreadId`. A step that changed provider while
 * inheriting the previous step's conversation would hand the new model a
 * transcript it has never seen and cannot read — so the conversation is dropped
 * and the step starts from the hand-off text instead.
 *
 * One function rather than an `a !== b` at each site, because the workflow
 * editor, the workflow runner and the step validator all have to agree on the
 * answer, and a rule spelt out three times is a rule that drifts.
 */
export function providerSwitchNeedsFreshStart(from: ModelProvider, to: ModelProvider): boolean {
  return from !== to;
}
