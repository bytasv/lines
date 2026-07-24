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
