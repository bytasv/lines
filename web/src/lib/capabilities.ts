import { capabilitiesFor, providerForModel } from '@lines/shared';
import type { ProviderCapabilities, SessionMeta } from '@lines/shared';

/**
 * What a session's engine can do, for the components that have to hide or disable
 * a control.
 *
 * A one-line wrapper on purpose: every client site should ask about a capability
 * rather than about a vendor, so that a control's reason for being absent is
 * written down once (in `shared/providers.ts`) instead of re-derived as
 * `provider === 'openai'` at each site. When codex gains steering, `interject`
 * flips there and Send-now comes back everywhere at once.
 */
export function sessionCaps(session: Pick<SessionMeta, 'model'>): ProviderCapabilities {
  return capabilitiesFor(providerForModel(session.model));
}

/**
 * What to call the agent in copy about *this session*, e.g. "Codex wants to run
 * a command".
 *
 * Session-scoped strings only. Copy about the *account* — the Claude login modal,
 * the Claude plan chip — stays Claude-specific, because it really is about
 * Claude and nothing else.
 */
export function agentLabel(session: Pick<SessionMeta, 'model'>): string {
  return providerForModel(session.model) === 'openai' ? 'Codex' : 'Claude';
}
