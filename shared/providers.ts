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
import type { ModelProvider, ReasoningEffort } from './types.ts';

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
  /**
   * Reasoning-effort levels this engine accepts, weakest first. Empty = no
   * control, and the picker hides itself the way `linesTools` and `rewind`
   * already gate UI.
   *
   * A list rather than a boolean plus a table elsewhere: the picker needs the
   * values anyway, and a flag would put the vocabulary somewhere this file could
   * not keep honest.
   */
  reasoningEfforts: readonly ReasoningEffort[];
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
  // The Agent SDK's top-level `effort` option (`EffortLevel` in sdk.d.ts).
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
};

/**
 * Codex over the app-server transport.
 *
 * `approvals` is on: codex asks before it acts, and the request is routed back
 * into the same permission card, auto-guard and allowlist a Claude call goes
 * through. `planMode` rides with it — plan mode is a read-only sandbox *plus* a
 * gate, and the gate is what was missing.
 *
 * `linesTools` is on, by a different route than Claude's: codex spawns every MCP
 * server as a child process, so the tools it hosts in-process for the SDK are
 * served to codex by a real stdio server (`linesMcpStdio.ts`) that proxies back
 * to the bridge. Two of the thirteen are session-scoped and decline there, since
 * codex names one server for the whole CODEX_HOME and a call cannot say which
 * thread made it.
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
  linesTools: true,
  mcpConnections: true,
  cost: false,
  // Measured against a real `codex app-server`, not taken from OpenAI's config
  // reference: that reference lists `minimal`, and a turn sent with it fails
  // outright — "Unsupported value: 'minimal' is not supported with the
  // 'gpt-5.6-terra' model. Supported values are: 'none', 'low', 'medium',
  // 'high', 'xhigh', and 'max'." `none` is left out because "no choice" is
  // already expressed by the field being absent, which hands the turn to codex's
  // own preset rather than turning reasoning off.
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
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
