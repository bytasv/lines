/**
 * The day-resolution spend ledger: what `SessionMeta.costByModel` cannot answer,
 * which is "what did I spend this month?".
 *
 * One file per user, held whole in memory and written back debounced — the same
 * shape `UsagePoller` and `SessionManager.persist()` already use. It is fed from
 * exactly one place (`SessionManager.accumulateResultSpend`, on the line after
 * the `addSpend` that maintains `costByModel`, with the identical arguments), so
 * the ledger and the per-session split cannot disagree about what counted.
 *
 * Bridge-local and not synced: see `SpendHistoryBlob` for why, and for what that
 * costs a multi-machine user.
 */
import { addSpend, dayKey } from '@lines/shared';
import type { ModelSpendMap, ServerMessage, SpendHistoryBlob } from '@lines/shared';
import type { Store } from './store.ts';

/** Same 250 ms coalescing window as `SessionManager.persist()`, for the same
 *  reason: a turn's worth of results must not mean a write each. */
const PERSIST_DEBOUNCE_MS = 250;

/**
 * Two years of day rows kept on load. At roughly 150 bytes a row the file is
 * ~110 KB/year, so this is a bound on unbounded growth rather than a size the
 * user would notice — and no period view reaches back past it.
 */
const MAX_DAYS = 730;

/** Newest `MAX_DAYS` rows. Day keys are fixed-width, so they sort as strings. */
function capDays(blob: SpendHistoryBlob): SpendHistoryBlob {
  const keys = Object.keys(blob.days);
  if (keys.length <= MAX_DAYS) return blob;
  const keep = keys.sort().slice(-MAX_DAYS);
  const days: Record<string, ModelSpendMap> = {};
  for (const key of keep) days[key] = blob.days[key];
  return { ...blob, days };
}

export class SpendHistory {
  private blob: SpendHistoryBlob;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(
    private store: Store,
    private broadcast: (msg: ServerMessage) => void,
  ) {
    this.blob = capDays(store.loadSpendHistory());
    // Stamped as the zone keys are *currently* being written in, not the one the
    // file was created in: already-written keys are frozen, and what a reader
    // needs to know is whether today's rows agree with their own clock.
    this.blob.tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  }

  /** The whole ledger, for `hello`. */
  get snapshot(): SpendHistoryBlob {
    return this.blob;
  }

  /**
   * Fold one turn's billed spend into the day it settled on. `costUsd` must be
   * the turn's own billed delta (`resultSpend().billed`), never a raw
   * `total_cost_usd` reading — see shared/resultSpend.ts.
   */
  record(modelId: string, costUsd: number, tokens: number, ts: number): void {
    const day = dayKey(ts);
    const row = (this.blob.days[day] ??= {});
    addSpend(row, modelId, costUsd, tokens);
    this.persist();
    // The whole row, so the client's handler is an idempotent replace.
    this.broadcast({ type: 'spendDay', day, spend: row });
  }

  private persist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.store.saveSpendHistory(this.blob);
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Land a pending debounced write. Called on shutdown, beside the session flush. */
  flush(): void {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.store.saveSpendHistory(this.blob);
  }
}
