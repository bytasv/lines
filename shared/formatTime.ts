/**
 * One exact timestamp format for every surface that shows a workflow's or a
 * step's creation/update time: `YYYY-MM-DD HH:MM`, in the reader's local zone.
 *
 * Hand-rolled rather than `Intl.DateTimeFormat`: the locale-aware formatters
 * vary separators and ordering by locale, and the editor, the MCP tool results
 * and the docs all quote this one shape.
 */
export function formatTimestamp(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
