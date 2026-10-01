import { isSessionActive, resolveStepContent } from '@lines/shared';
import type { SessionMeta, SessionStatus, StepContent, WorkflowDef } from '@lines/shared';

const STATUS_META: Record<SessionStatus, { color: string; label: string }> = {
  idle: { color: 'gray', label: 'idle' },
  running: { color: 'blue', label: 'running' },
  done: { color: 'green', label: 'done' },
  'waiting-permission': { color: 'yellow', label: 'needs permission' },
  'waiting-approval': { color: 'cyan', label: 'needs approval' },
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
 * The step a manual provider switch would hand the workflow back to, or null when
 * there is none (no workflow, not started, or already finished).
 *
 * A switch is one-shot: the model is the user's for now, and the next step entry
 * re-applies the model that step names (WorkflowEngine.runStep). That is what the
 * confirm dialog has to say out loud — and `inherits` is what decides whether it
 * also has to say the step will restart from the previous step's output, since a
 * step already marked `freshStart` would have done exactly that anyway.
 *
 * Which step is next follows the stepper's own reading: a step parked for
 * approval or already done hands over to the one after it; anything else (pending,
 * running) is still the current step's turn to come.
 *
 * A `StepRef` whose content this client cannot resolve reads as inheriting — the
 * cautious answer, since the caveat is a warning and omitting it is the lie.
 */
export function stepAfterProviderSwitch(
  session: SessionMeta,
  workflow: WorkflowDef,
  lookup: (ownerId: string, stepId: string, version: number) => StepContent | undefined,
): { index: number; model: string; inherits: boolean } | null {
  const wf = session.workflow;
  if (!wf?.started || isWorkflowFinished(session)) return null;
  const current = wf.stepStatuses[wf.stepIndex];
  const index = current === 'done' || current === 'waiting-approval' ? wf.stepIndex + 1 : wf.stepIndex;
  const step = workflow.steps[index];
  if (!step) return null;
  const content = resolveStepContent(step, lookup);
  return { index, model: content?.model ?? '', inherits: !content?.freshStart };
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
  STATUS_META['waiting-approval'], // needs approval   — cyan
  waitingPermissionMeta(undefined), // needs permission — yellow
  INTERRUPTED_META, // interrupted      — yellow
  STATUS_META.error, // error            — red
];

/** Keyed on label — all six are distinct, so a rename propagates for free. */
const PROJECT_STATUS_RANK = new Map(PROJECT_STATUS_ORDER.map((m, i) => [m.label, i]));

/** How the sidebar orders a session list — persisted per browser. */
export type SessionSort = 'status' | 'activity' | 'created';

/** localStorage key the sidebar's sort persists under; the store reads it too. */
export const SESSION_SORT_KEY = 'lines.sessionSort';

/**
 * Sidebar row order for `status` mode, most urgent first: the running turn, then
 * the states that need the user in the tab-dot order above, then everything
 * settled. Built from the same tables `sessionRowMeta` and `projectStatusMeta`
 * read, so the list order can never drift from the dot that points at it.
 */
const SESSION_SORT_ORDER = [
  STATUS_META.running,
  ...PROJECT_STATUS_ORDER,
  BACKGROUND_WORK_META,
  STATUS_META.done,
  STATUS_META.idle,
];

/** Keyed on label, exactly as `PROJECT_STATUS_RANK` is — all labels are distinct. */
const SESSION_SORT_RANK = new Map(SESSION_SORT_ORDER.map((m, i) => [m.label, i]));

/**
 * The closest thing to a last-activity clock: `updatedAt` is stamped by every
 * `SessionManager.upsert`, and `adoptSynced` deliberately does not restamp, so it
 * already means "last change made here or synced from elsewhere". Falls back to
 * `createdAt` for a session that has not been upserted since it was made.
 */
function lastActivityAt(session: SessionMeta): number {
  return session.updatedAt ?? session.createdAt;
}

/**
 * Comparator for a sidebar session list. `status` ranks by urgency and tie-breaks
 * on activity; a label missing from the rank table (a future `SessionStatus`)
 * sorts last rather than being guessed at — the same rule `projectStatusMeta`
 * applies by skipping.
 */
export function compareSessions(mode: SessionSort): (a: SessionMeta, b: SessionMeta) => number {
  if (mode === 'created') return (a, b) => b.createdAt - a.createdAt;
  if (mode === 'activity') return (a, b) => lastActivityAt(b) - lastActivityAt(a);
  return (a, b) => {
    const rank = (s: SessionMeta) =>
      SESSION_SORT_RANK.get(sessionRowMeta(s).label) ?? SESSION_SORT_ORDER.length;
    return rank(a) - rank(b) || lastActivityAt(b) - lastActivityAt(a);
  };
}

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

/**
 * A spend figure, marked when it is an estimate rather than money the provider
 * reported: `~$1.23` against `$1.23`.
 *
 * A visible prefix rather than a dimmed style or a tooltip. Dimmed is already
 * the ambient colour at every one of these sites, so dimming would say nothing;
 * a tooltip does not exist on touch. The tilde is what carries the distinction
 * everywhere, and the usage card spells out once what it means.
 *
 * Always two decimals, at every site, so no readout disagrees with another.
 */
export function formatSpendUsd(usd: number, estimated: boolean): string {
  return `${estimated ? '~' : ''}$${usd.toFixed(2)}`;
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
