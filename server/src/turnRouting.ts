/**
 * Smart turn routing, the pure half: which rule applies to a session's next turn,
 * and whether a JEV answer is one the turn should actually move to. No I/O and
 * no session — SessionManager.pushTurn owns the call and the side effects.
 */
import {
  DEFAULT_ROUTING_MIN_CONFIDENCE,
  ROUTING_MODES,
  providerForModel,
  validateRoutingRule,
  type ModelProvider,
  type ReasoningEffort,
  type RoutingRule,
  type SessionMeta,
  type UserUiSettings,
} from '@lines/shared';
import type { JevDecision } from './jev.ts';

/**
 * The rule for this session's next turn, or undefined when it is not routed.
 *
 * Off, paused and plan mode all mean no rule: plan mode already has its own
 * global effort (`planReasoningEffort`, see resolveReasoningEffort), and that
 * keeps winning. Otherwise a routed workflow step's own rule beats the global
 * one for the session's provider.
 */
export function resolveRule(
  meta: Pick<SessionMeta, 'model' | 'permissionMode' | 'routingPaused'>,
  settings: Pick<UserUiSettings, 'smartRouting'> | null | undefined,
  stepRule?: RoutingRule,
): RoutingRule | undefined {
  const routing = settings?.smartRouting;
  if (!routing || routing.mode === 'off') return undefined;
  if (meta.routingPaused) return undefined;
  if (meta.permissionMode === 'plan') return undefined;
  const provider = providerForModel(meta.model);
  const rule = stepRule ?? routing.rules?.[provider];
  if (!rule) return undefined;
  // A rule saved for the other provider (or a hand-edited blob) must never move
  // a turn across providers — setModel would refuse it mid-conversation.
  if (!rule.models.every((m) => providerForModel(m) === provider)) return undefined;
  return rule;
}

export interface RoutingChange {
  /** Present only when the model changes. */
  model?: string;
  /** Present only when the effort changes. */
  effort?: ReasoningEffort;
  /** Lowest confidence among the parts that changed. */
  confidence: number;
}

/**
 * The change a JEV answer asks for, or null when there is nothing to do. Model
 * and effort are gated independently: a confident effort bump can apply while an
 * unsure model pick is dropped. Anything outside the rule's allowlist, below its
 * confidence floor, or equal to what the session already runs is ignored.
 */
export function acceptPick(
  pick: JevDecision | null,
  rule: RoutingRule,
  current: { model: string; effort?: ReasoningEffort },
): RoutingChange | null {
  if (!pick) return null;
  const min = rule.minConfidence ?? DEFAULT_ROUTING_MIN_CONFIDENCE;
  const change: RoutingChange = { confidence: 1 };
  let changed = false;
  if (
    pick.model &&
    rule.models.includes(pick.model.id) &&
    pick.model.confidence >= min &&
    pick.model.id !== current.model
  ) {
    change.model = pick.model.id;
    change.confidence = Math.min(change.confidence, pick.model.confidence);
    changed = true;
  }
  if (
    pick.effort &&
    rule.efforts.includes(pick.effort.level) &&
    pick.effort.confidence >= min &&
    pick.effort.level !== current.effort
  ) {
    change.effort = pick.effort.level;
    change.confidence = Math.min(change.confidence, pick.effort.confidence);
    changed = true;
  }
  return changed ? change : null;
}

/**
 * Problems with a settings blob's `smartRouting`, as messages; empty when it is
 * absent or valid. Each provider's rule is checked against that provider, so a
 * saved rule can never move a turn across providers.
 */
export function smartRoutingIssues(routing: UserUiSettings['smartRouting'] | undefined): string[] {
  if (routing === undefined) return [];
  if (!routing || typeof routing !== 'object') return ['smartRouting must be an object'];
  const issues: string[] = [];
  if (!ROUTING_MODES.includes(routing.mode)) issues.push(`Unknown routing mode "${String(routing.mode)}"`);
  const rules = routing.rules ?? {};
  if (typeof rules !== 'object') return [...issues, 'smartRouting.rules must be an object'];
  for (const [provider, rule] of Object.entries(rules)) {
    if (provider !== 'anthropic' && provider !== 'openai') {
      issues.push(`Unknown routing provider "${provider}"`);
      continue;
    }
    if (!rule) continue;
    for (const message of validateRoutingRule(rule, provider as ModelProvider)) issues.push(`${provider}: ${message}`);
  }
  return issues;
}
