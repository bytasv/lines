import type { SessionMeta, WorkflowDef } from '@lines/shared';

export interface RecentWorkflow {
  def: WorkflowDef;
  /** ms epoch of the newest session that ran it; undefined for the pref fallback. */
  lastRunAt?: number;
}

/**
 * The workflows this project's sessions ran most recently, newest first, one
 * entry per workflow and only ones that still exist in `launchable`. With no
 * history at all, the workflow last picked from the new-session menu
 * (`fallbackId`, the old `newSessionChoice` pref) stands in.
 */
export function recentWorkflows(
  sessions: readonly SessionMeta[],
  launchable: readonly WorkflowDef[],
  limit = 3,
  fallbackId?: string,
): RecentWorkflow[] {
  const byId = new Map(launchable.map((w) => [w.id, w]));
  const out: RecentWorkflow[] = [];
  const seen = new Set<string>();
  const ran = sessions
    .filter((s) => s.workflow?.workflowId)
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const s of ran) {
    const id = s.workflow!.workflowId;
    if (seen.has(id)) continue;
    seen.add(id);
    const def = byId.get(id);
    if (!def) continue;
    out.push({ def, lastRunAt: s.createdAt });
    if (out.length >= limit) return out;
  }
  if (out.length === 0 && fallbackId) {
    const def = byId.get(fallbackId);
    if (def) out.push({ def });
  }
  return out;
}

/**
 * A session nothing has happened in yet, judged from its meta alone: no
 * conversation, nothing queued, no workflow under way. The new-session picker
 * shows on one (with the transcript checked too), and leaving a session lands on
 * one rather than opening another.
 */
export function isFreshSession(s: SessionMeta): boolean {
  return (
    !s.archived &&
    !s.completed &&
    !s.claudeSessionId &&
    !s.codexThreadId &&
    !s.queued?.length &&
    !s.workflow?.started &&
    !s.goal &&
    // Any turn ever run leaves one of these behind, even one that failed or
    // was interrupted before the provider named a conversation.
    !s.totalDurationMs &&
    !s.totalTokens &&
    !s.totalCostUsd &&
    !s.interruptedAt &&
    !s.turnSource &&
    s.status === 'idle'
  );
}

/**
 * Not started yet: fresh, still on its placeholder name, nothing steering in.
 * The sidebar leaves such a session out until its first prompt, and the New
 * session button reopens one rather than creating another.
 */
export function isUnstarted(s: SessionMeta): boolean {
  return isFreshSession(s) && s.nameAuto === true && !s.steering?.length;
}

/**
 * Whether this session shows the new-session view: fresh by its meta, not
 * read-only, its transcript loaded and empty, and nothing on its way in.
 * Leaving a session reopens only one that passes this, so the user always lands
 * on that view rather than on a conversation.
 */
export function showsNewSessionView(
  s: SessionMeta,
  view: { loaded: boolean; events: number; sending: boolean; offlineQueued: boolean },
): boolean {
  return (
    view.loaded &&
    view.events === 0 &&
    !view.sending &&
    !view.offlineQueued &&
    !s.readOnly &&
    isFreshSession(s)
  );
}
