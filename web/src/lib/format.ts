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
