import type { Actor, GoalMarkerData, GoalState, SessionMeta, TurnSource } from '@lines/shared';
import { clampGoalMaxTurns, GOAL_CONDITION_MAX, isSessionActive } from '@lines/shared';
import type { SessionManager } from './sessions.ts';

/** The judge runs on the same small model as auto-name and the plan-read check. */
const GOAL_JUDGE_MODEL = 'claude-haiku-5-5';
/** How much of the turn's final reply the judge reads (its tail — where results land). */
const GOAL_JUDGE_INPUT_MAX = 8_000;
/** Cap on a verdict reason kept on the goal and shown in markers. */
const GOAL_REASON_MAX = 300;

const GOAL_JUDGE_SYSTEM_PROMPT = [
  "You check whether a coding agent has met its session goal. You are given the goal's",
  "completion condition and the agent's latest reply.",
  'Answer with strict JSON only — no prose, no code fence:',
  '{"met": true|false, "reason": "<one short sentence>"}',
  'Say met only when the reply shows the condition holds. When unsure, say not met and',
  'name what is still missing.',
].join('\n');

/** What the judge decided about a goal, and why. */
export interface GoalVerdict {
  met: boolean;
  reason: string;
}

/**
 * The judge's answer, read strictly: `{ met, reason }` when it is exactly a JSON
 * object with a boolean `met`, null for anything else (prose, a non-boolean, a
 * fence around more than the object) — which the engine treats as a failed judge.
 */
export function parseGoalVerdict(answer: string | null): GoalVerdict | null {
  if (!answer) return null;
  const body = answer.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { met, reason } = parsed as { met?: unknown; reason?: unknown };
  if (typeof met !== 'boolean') return null;
  const why = typeof reason === 'string' ? reason.trim().slice(0, GOAL_REASON_MAX) : '';
  return { met, reason: why || (met ? 'The goal is met.' : 'The goal is not met yet.') };
}

/** A goal in one of the states that drives turns on its own. */
export function goalDrivesTurns(goal: GoalState | undefined): boolean {
  return goal?.status === 'active' || goal?.status === 'evaluating';
}

/**
 * The session has a workflow that has not reached its last step's 'done'. Its
 * goals are the steps' (WorkflowEngine.setStepGoal), not the session's.
 */
export function hasUnfinishedWorkflow(meta: SessionMeta): boolean {
  const wf = meta.workflow;
  if (!wf) return false;
  const finished = !!wf.started && wf.stepStatuses.length > 0 && wf.stepStatuses.every((s) => s === 'done');
  return !finished;
}

/** The prompt that opens a goal on an idle session. */
export function goalStartText(condition: string): string {
  return `Work toward this goal: ${condition}`;
}

/** The prompt sent when the judge says the goal is not met yet. */
export function goalContinuationText(condition: string, reason: string): string {
  return [
    `The session goal is not met yet: ${condition}`,
    '',
    `Why it is not met: ${reason}`,
    '',
    'Keep working toward the goal.',
  ].join('\n');
}

type SettleArgs = [sessionId: string, source: TurnSource, interrupted: boolean, failed: boolean];

/**
 * Session goals: after every settled turn, a small model checks the goal's
 * completion condition against the turn's reply; while it is unmet the engine
 * re-prompts the agent (source `'goal'`), up to the goal's turn cap.
 *
 * Sits beside WorkflowEngine on the same turn-complete fan-out. Goal state lives
 * on `SessionMeta.goal`, persisted and broadcast like `workflow`. A session with
 * an unfinished workflow has step goals instead (WorkflowEngine.setStepGoal),
 * judged by the same `evaluate`.
 */
export class GoalEngine {
  /** Sessions whose judge call is in flight. */
  private judging = new Set<string>();
  /** A settle that landed while the judge ran (the user prompted meanwhile);
   *  replayed once the stale verdict is dropped. */
  private deferred = new Map<string, SettleArgs>();

  constructor(private sessions: SessionManager) {
    sessions.addTurnCompleteListener((sessionId, source, interrupted, failed) => {
      void this.onTurnComplete(sessionId, source, interrupted, failed);
    });
  }

  devReloadBlockers(): string[] {
    return this.judging.size ? ['goal evaluation in flight'] : [];
  }

  /**
   * Set, replace or resume the session goal. Resuming is the same call: a fresh
   * turn budget and status `active`. An idle session gets its first turn now; a
   * running one is judged when that turn settles.
   */
  setGoal(
    sessionId: string,
    condition: string,
    maxTurns: number | undefined,
    actor?: Actor,
  ): { ok: true } | { ok: false; reason: string } {
    const meta = this.sessions.get(sessionId);
    if (!meta) return { ok: false, reason: 'Unknown session.' };
    const text = condition.trim().slice(0, GOAL_CONDITION_MAX);
    if (!text) return { ok: false, reason: 'Describe when the goal is met.' };
    // index.ts routes a workflow session's goal to its current step; this is the
    // backstop that keeps the two engines from both driving one session.
    if (hasUnfinishedWorkflow(meta)) {
      return { ok: false, reason: 'This session is running a workflow — set the goal on its current step.' };
    }
    const goal: GoalState = {
      condition: text,
      maxTurns: clampGoalMaxTurns(maxTurns),
      turnsUsed: 0,
      status: 'active',
      setAt: Date.now(),
      ...(actor ? { actor } : {}),
    };
    meta.goal = goal;
    this.marker(sessionId, { event: 'set', condition: text, turnsUsed: 0, maxTurns: goal.maxTurns });
    this.sessions.persistMeta(sessionId);
    if (!this.isBusy(meta)) {
      // A goal set on a fresh session names it, as a first typed prompt would.
      this.sessions.maybeAutoName(sessionId, text);
      this.sessions.prompt(sessionId, goalStartText(text), 'goal', [], [], actor);
    }
    return { ok: true };
  }

  clearGoal(sessionId: string) {
    const meta = this.sessions.get(sessionId);
    if (!meta?.goal) return;
    delete meta.goal;
    this.deferred.delete(sessionId);
    this.marker(sessionId, { event: 'cleared' });
    this.sessions.persistMeta(sessionId);
  }

  /** True while a goal blocks starting a workflow on this session. */
  blocksWorkflow(sessionId: string): boolean {
    return goalDrivesTurns(this.sessions.get(sessionId)?.goal);
  }

  async onTurnComplete(sessionId: string, source: TurnSource, interrupted: boolean, failed: boolean): Promise<void> {
    const meta = this.sessions.get(sessionId);
    const goal = meta?.goal;
    if (!meta || !goal) return;
    // A workflow's turns are judged by its step goal, in WorkflowEngine.
    if (hasUnfinishedWorkflow(meta)) return;
    if (goal.status === 'evaluating' && this.judging.has(sessionId)) {
      // Another turn (the user's) settled while the judge read the previous one.
      // Its verdict is stale now; this settle is judged once that call returns.
      this.deferred.set(sessionId, [sessionId, source, interrupted, failed]);
      return;
    }
    if (goal.status !== 'active') return;

    if (interrupted) {
      // Stop never auto-continues.
      this.update(sessionId, goal, { status: 'stopped' });
      this.marker(sessionId, { event: 'stopped', turnsUsed: goal.turnsUsed, maxTurns: goal.maxTurns });
      return;
    }
    if (failed) {
      // No retry loop: a failed turn waits for the user.
      this.pause(sessionId, goal, 'turn-failed');
      return;
    }

    this.update(sessionId, goal, { status: 'evaluating' });
    this.judging.add(sessionId);
    let verdict: GoalVerdict | null;
    try {
      verdict = await this.judge(sessionId, goal.condition);
    } finally {
      this.judging.delete(sessionId);
    }

    // The goal was cleared or replaced while the judge ran: its verdict is moot.
    const now = this.sessions.get(sessionId);
    // Re-read through a widened type: the await above is what can move it.
    const status = goal.status as GoalState['status'];
    if (!now || now.goal !== goal || status !== 'evaluating') return;

    const replay = this.deferred.get(sessionId);
    if (replay) {
      this.deferred.delete(sessionId);
      this.update(sessionId, goal, { status: 'active' });
      return this.onTurnComplete(...replay);
    }

    if (!verdict) {
      this.pause(sessionId, goal, 'judge-failed');
      return;
    }
    const lastVerdict = { ...verdict, at: Date.now() };
    if (verdict.met) {
      this.update(sessionId, goal, { status: 'met', lastVerdict });
      this.marker(sessionId, { event: 'met', reason: verdict.reason, turnsUsed: goal.turnsUsed, maxTurns: goal.maxTurns });
      return;
    }
    if (goal.turnsUsed >= goal.maxTurns) {
      goal.lastVerdict = lastVerdict;
      this.pause(sessionId, goal, 'cap', verdict.reason);
      return;
    }
    // The user queued or sent something while the judge ran: theirs goes first,
    // and the goal is judged again when that turn settles.
    if (this.isBusy(now)) {
      this.update(sessionId, goal, { status: 'active', lastVerdict });
      return;
    }
    this.update(sessionId, goal, { status: 'active', lastVerdict, turnsUsed: goal.turnsUsed + 1 });
    this.marker(sessionId, { event: 'unmet', reason: verdict.reason, turnsUsed: goal.turnsUsed, maxTurns: goal.maxTurns });
    this.sessions.prompt(sessionId, goalContinuationText(goal.condition, verdict.reason), 'goal', [], [], goal.actor);
  }

  /** Judge `condition` against the session's last reply. Null when the judge failed. */
  evaluate(sessionId: string, condition: string): Promise<GoalVerdict | null> {
    return this.judge(sessionId, condition);
  }

  private async judge(sessionId: string, condition: string): Promise<GoalVerdict | null> {
    const reply = this.sessions.lastAssistantText(sessionId).slice(-GOAL_JUDGE_INPUT_MAX);
    let answer: string | null;
    try {
      answer = await this.sessions.helper({
        prompt: [
          `Goal condition:\n${condition}`,
          '',
          `Agent's latest reply:\n${reply || '(no text)'}`,
        ].join('\n'),
        systemPrompt: GOAL_JUDGE_SYSTEM_PROMPT,
        claudeModel: GOAL_JUDGE_MODEL,
        sessionId,
      });
    } catch {
      answer = null;
    }
    return parseGoalVerdict(answer);
  }

  /** Same notion of busy as the session queue: a turn running or parked, or prompts waiting. */
  private isBusy(meta: SessionMeta): boolean {
    return (
      isSessionActive(meta.status) ||
      !!meta.queued?.length ||
      !!meta.steering?.length ||
      !!meta.workflow?.advancing
    );
  }

  private pause(sessionId: string, goal: GoalState, pauseReason: NonNullable<GoalState['pauseReason']>, reason?: string) {
    this.update(sessionId, goal, { status: 'paused', pauseReason });
    this.marker(sessionId, {
      event: 'paused',
      pauseReason,
      ...(reason ? { reason } : {}),
      turnsUsed: goal.turnsUsed,
      maxTurns: goal.maxTurns,
    });
  }

  /** Mutate the goal in place (identity is what a late verdict checks) and persist. */
  private update(sessionId: string, goal: GoalState, patch: Partial<GoalState>) {
    Object.assign(goal, patch);
    if (patch.status && patch.status !== 'paused') delete goal.pauseReason;
    this.sessions.persistMeta(sessionId);
  }

  private marker(sessionId: string, data: GoalMarkerData) {
    this.sessions.emitEvent(sessionId, 'goal', data);
  }
}
