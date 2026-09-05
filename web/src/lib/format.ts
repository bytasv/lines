import { isSessionActive } from '@lines/shared';
import type { SessionMeta, SessionStatus } from '@lines/shared';

const STATUS_META: Record<SessionStatus, { color: string; label: string }> = {
  idle: { color: 'gray', label: 'idle' },
  running: { color: 'blue', label: 'running' },
  done: { color: 'green', label: 'done' },
  'waiting-permission': { color: 'yellow', label: 'needs permission' },
  'waiting-approval': { color: 'sandstone', label: 'needs approval' },
  error: { color: 'red', label: 'error' },
};

/** Interrupted turns have no `SessionStatus` of their own — they stay `idle`. */
const INTERRUPTED_META = { color: 'yellow', label: 'interrupted' };

/** A settled turn whose CLI process still owns background tasks — see
 *  `SessionMeta.backgroundTasks`. Not a status: the turn really is over. */
const BACKGROUND_WORK_META = { color: 'blue', label: 'background work' };

/**
 * Dot color + badge label for a sidebar session row. Precedence mirrors the
 * banner order in `SessionView`: a pending permission first, then an
 * interrupted-but-continuable turn, then the plain status mapping.
 */
export function sessionRowMeta(session: SessionMeta): {
  color: string;
  label: string;
  /** Interrupted sessions are `idle`, but must still read as actionable. */
  actionable: boolean;
} {
  if (session.status === 'waiting-permission') {
    return { ...waitingPermissionMeta(session.pendingPermissionTool), actionable: true };
  }
  // Same guard as the Continue banner — keep the two in step.
  if (session.interruptedAt && !isSessionActive(session.status) && session.status !== 'error') {
    return { ...INTERRUPTED_META, actionable: true };
  }
  // Below the two above on purpose: both of those need the user, and this does
  // not. Deliberately not actionable either — a background task is informational,
  // and a project folder must not light up for it.
  if (session.backgroundTasks?.length && !isSessionActive(session.status)) {
    return { ...BACKGROUND_WORK_META, actionable: false };
  }
  const meta = STATUS_META[session.status] ?? STATUS_META.idle;
  const { status } = session;
  return {
    ...meta,
    actionable: status !== 'idle' && status !== 'running' && status !== 'done',
  };
}

/** Every step of the session's workflow reached 'done' — see workflows advance():
 *  the last step is marked done with no further stepIndex bump, so there is no
 *  stored "finished" flag to read. */
export function isWorkflowFinished(session: SessionMeta): boolean {
  const wf = session.workflow;
  return (
    !!wf?.started && wf.stepStatuses.length > 0 && wf.stepStatuses.every((s) => s === 'done')
  );
}

/**
 * The step index a failure banner may offer to skip, or null when skipping isn't
 * on the table. Mirrors WorkflowEngine.retryIfFailed's gate — the failed step has
 * to be the one parked at waiting-approval, with no advance in flight — so the
 * button never appears for a click `approve` would refuse.
 */
export function skippableFailedStep(session: SessionMeta): number | null {
  const wf = session.workflow;
  if (!wf?.stepFailure || wf.advancing) return null;
  const i = wf.stepIndex;
  return wf.stepStatuses[i] === 'waiting-approval' ? i : null;
}

/**
 * Label + badge color for a `waiting-permission` session, keyed off the tool
 * that triggered the pause. `AskUserQuestion` reads as a question and
 * `ExitPlanMode` as a plan-ready state; every other tool is a plain permission
 * ask (the existing yellow default).
 */
export function waitingPermissionMeta(tool?: string): { label: string; color: string } {
  switch (tool) {
    case 'ExitPlanMode':
      return { label: 'plan ready', color: 'violet' };
    case 'AskUserQuestion':
      return { label: 'needs answer', color: 'teal' };
    default:
      return { label: 'needs permission', color: 'yellow' };
  }
}

/**
 * Which actionable state wins when a project tab can only show one dot, most
 * urgent first. Built from the same tables `sessionRowMeta` reads so a tab dot
 * can never drift from the sidebar dot it points at.
 */
const PROJECT_STATUS_ORDER = [
  waitingPermissionMeta('ExitPlanMode'), // plan ready       — violet
  waitingPermissionMeta('AskUserQuestion'), // needs answer     — teal
  STATUS_META['waiting-approval'], // needs approval   — sandstone
  waitingPermissionMeta(undefined), // needs permission — yellow
  INTERRUPTED_META, // interrupted      — yellow
  STATUS_META.error, // error            — red
];

/** Keyed on label — all six are distinct, so a rename propagates for free. */
const PROJECT_STATUS_RANK = new Map(PROJECT_STATUS_ORDER.map((m, i) => [m.label, i]));

/**
 * The single most urgent *unseen* actionable state across a project's sessions,
 * or `null` when nothing needs the user (caller keeps the plain folder icon).
 *
 * `seen` is the store's `seenSessionStatus` map — session id to the label the
 * user has already looked at. Anything matching is skipped, so visiting a
 * project quiets its tab until some session reaches a state the user hasn't
 * seen yet.
 *
 * `running`/`done`/`idle` are already `actionable: false`, so they fall through
 * without a second check. Archived sessions are skipped; `completed` needs no
 * guard of its own because the server always sets it alongside `archived`.
 * A label missing from the rank table (a future `SessionStatus`) is skipped
 * rather than guessed at.
 */
export function projectStatusMeta(
  sessions: SessionMeta[],
  seen: Record<string, string>,
): { color: string; label: string } | null {
  let best: { color: string; label: string } | null = null;
  let bestRank = Infinity;
  for (const session of sessions) {
    if (session.archived) continue;
    const meta = sessionRowMeta(session);
    if (!meta.actionable || seen[session.id] === meta.label) continue;
    const rank = PROJECT_STATUS_RANK.get(meta.label);
    if (rank == null || rank >= bestRank) continue;
    best = { color: meta.color, label: meta.label };
    bestRank = rank;
    if (rank === 0) break;
  }
  return best;
}

/**
 * What a machine is doing right now, for the machine list and picker: how many
 * of its sessions are mid-turn, and how many are waiting on the user.
 *
 * Derived from the sessions the client already holds rather than reported by the
 * bridge, and counted through `sessionRowMeta` so a machine's summary and its
 * session rows can never disagree about what "actionable" means. Archived
 * sessions are skipped, exactly as `projectStatusMeta` skips them.
 *
 * Takes a plain array: `format.ts` never imports the store, and per-machine
 * grouping belongs to the caller.
 */
export function machineActivity(sessions: SessionMeta[]): { running: number; actionable: number } {
  let running = 0;
  let actionable = 0;
  for (const session of sessions) {
    if (session.archived) continue;
    if (session.status === 'running') running++;
    else if (sessionRowMeta(session).actionable) actionable++;
  }
  return { running, actionable };
}

/** Green under 50%, amber to 80%, red above — mirrors ClaudeUsageBar's thresholds. */
export function usageColor(pct: number): string {
  return pct >= 80 ? 'red' : pct >= 50 ? 'yellow' : 'teal';
}

/** Compact token count: `840`, `12.3k`, `1.05M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Human-friendly duration for step/session scale: `Xs` under a minute,
 *  `Xm Ys` under an hour, else `Xh Ym`. */
export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ${totalSec % 60}s`;
  const hours = Math.floor(totalMin / 60);
  return `${hours}h ${totalMin % 60}m`;
}
