/**
 * Replays a session's spend from what is on disk, the way the live bridge bills
 * it as it happens (`accumulateResultSpend` in server/src/sessions.ts): every
 * `result` through the shared cost lineage, split by the models that spent it,
 * charged to the workflow step that was current. Shared by `repair-spend.ts` and
 * `backfill-spend-history.ts`, so the two rebuilds cannot disagree with each
 * other or with live.
 *
 * Throwaway, with the scripts that use it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  capabilitiesFor,
  CostLineage,
  estimateSpendUsd,
  providerForModel,
  resolveModelId,
} from '@lines/shared';
import type { ResultSpendPayload, SessionMeta, WorkflowMarkerData } from '@lines/shared';

export const USERS_ROOT = path.join(os.homedir(), '.lines-app', 'users');

/**
 * Whether a bridge is up and would write its in-memory copy back over a repair.
 * The dev bridge answers on :8787; the desktop app's binds a free port, so the
 * lock file's pid is the other half of the check.
 */
export async function bridgeRunning(): Promise<string | null> {
  try {
    const res = await fetch('http://localhost:8787/', { signal: AbortSignal.timeout(1500) });
    if (res.ok) return 'a bridge is answering on :8787';
  } catch {
    // Not that one.
  }
  try {
    const lock = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.lines-app', 'bridge.lock'), 'utf8'),
    ) as { pid?: unknown };
    if (typeof lock.pid === 'number') {
      process.kill(lock.pid, 0); // throws when no such process
      return `bridge.lock names pid ${lock.pid}, which is running (quit the desktop app)`;
    }
  } catch {
    // No lock, or its process is gone.
  }
  return null;
}

interface DiskEvent {
  seq: number;
  ts: number;
  kind: string;
  data: unknown;
}

/**
 * One session's events — the transcript and every rewind sidecar, which keeps
 * the tail a rewind cut off — in the order they happened. The spend in a cut
 * tail was real and was billed when it happened, so a rebuild includes it.
 */
export function sessionEvents(root: string, sessionId: string): DiskEvent[] {
  const dir = path.join(root, 'transcripts');
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter(
      (f) =>
        f === `${sessionId}.jsonl` || (f.startsWith(`${sessionId}.rewind-`) && f.endsWith('.jsonl')),
    );
  const out: DiskEvent[] = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let event: Partial<DiskEvent>;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // a torn trailing line; the rest of the file is still usable
      }
      if (typeof event.seq !== 'number' || typeof event.ts !== 'number' || !event.kind) continue;
      out.push(event as DiskEvent);
    }
  }
  return out.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
}

/** One billed result, attributed. */
export interface ReplayedResult {
  ts: number;
  costUsd?: number;
  tokens?: number;
  /** Split by model, in the key space `costByModel` uses. */
  models: { modelId: string; costUsd: number; tokens: number }[];
  /** The workflow step it was charged to, when one was under way. */
  step?: number;
}

export interface Replay {
  results: ReplayedResult[];
  totalCostUsd?: number;
  totalTokens?: number;
  /** The last turn's figures: everything since the last prompt. */
  lastCostUsd?: number;
  lastTokens?: number;
  /** Per-step spend of the session's current workflow run, when its markers
   *  survive to say which step each result belongs to. */
  steps?: { costUsd: number[]; tokens: number[] };
}

export function replaySpend(meta: SessionMeta, events: DiskEvent[]): Replay {
  const sessionModel = resolveModelId(meta.model);
  const estimating = !capabilitiesFor(providerForModel(sessionModel)).cost;
  const lineage = new CostLineage();
  const replay: Replay = { results: [] };

  // The current workflow run begins at its last step-0 start; markers before it
  // belong to an earlier run, whose spend the current step arrays never held.
  const stepCount = meta.workflow?.stepStatuses.length ?? 0;
  let runStart = -1;
  if (stepCount) {
    events.forEach((e, i) => {
      const marker = e.data as Partial<WorkflowMarkerData>;
      if (e.kind === 'workflow' && marker.event === 'started' && marker.stepIndex === 0) runStart = i;
    });
  }
  const steps =
    runStart >= 0
      ? { costUsd: new Array<number>(stepCount).fill(0), tokens: new Array<number>(stepCount).fill(0) }
      : undefined;
  let step: number | undefined;

  events.forEach((e, i) => {
    if (e.kind === 'user') {
      // A prompt starts a turn, whose figures start empty (resetTurnFigures).
      replay.lastCostUsd = undefined;
      replay.lastTokens = undefined;
      return;
    }
    if (e.kind === 'workflow') {
      if (i < runStart) return;
      const marker = e.data as Partial<WorkflowMarkerData>;
      const index = marker.stepIndex;
      // A step is under way from its start until it is approved past: parked
      // waiting for approval still counts, as it does live (chargeStep).
      step =
        (marker.event === 'started' || marker.event === 'retried' || marker.event === 'waiting-approval') &&
        typeof index === 'number' &&
        index < stepCount
          ? index
          : undefined;
      return;
    }
    const data = e.data as { type?: string } | undefined;
    if (e.kind !== 'sdk' || data?.type !== 'result') return;
    const payload = data as ResultSpendPayload;
    const spend = lineage.bill(payload);
    const usage = payload.usage;
    const tokens =
      spend?.tokens ??
      (usage
        ? (usage.input_tokens ?? 0) +
          (usage.output_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.reasoning_output_tokens ?? 0)
        : undefined);
    let costUsd = spend?.billed;
    if (!spend && usage && estimating) costUsd = estimateSpendUsd(sessionModel, usage);
    if (costUsd != null) {
      replay.totalCostUsd = (replay.totalCostUsd ?? 0) + costUsd;
      replay.lastCostUsd = (replay.lastCostUsd ?? 0) + costUsd;
    }
    if (tokens != null) {
      replay.totalTokens = (replay.totalTokens ?? 0) + tokens;
      replay.lastTokens = (replay.lastTokens ?? 0) + tokens;
    }
    if (!spend && tokens == null) return;
    const shares = spend?.models && Object.entries(spend.models);
    const models = shares?.length
      ? shares.map(([key, share]) => ({
          modelId: resolveModelId(share.canonical ?? key),
          costUsd: share.costUsd,
          tokens: share.tokens,
        }))
      : [{ modelId: sessionModel, costUsd: costUsd ?? 0, tokens: tokens ?? 0 }];
    const charged = steps && i > runStart ? step : undefined;
    if (charged != null) {
      steps!.costUsd[charged] += costUsd ?? 0;
      steps!.tokens[charged] += tokens ?? 0;
    }
    replay.results.push({
      ts: e.ts,
      ...(costUsd != null ? { costUsd } : {}),
      ...(tokens != null ? { tokens } : {}),
      models,
      ...(charged != null ? { step: charged } : {}),
    });
  });
  if (steps) replay.steps = steps;
  return replay;
}
