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
    return { color: 'yellow', label: 'interrupted', actionable: true };
  }
  const meta = STATUS_META[session.status] ?? STATUS_META.idle;
  const { status } = session;
  return {
    ...meta,
    actionable: status !== 'idle' && status !== 'running' && status !== 'done',
  };
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
