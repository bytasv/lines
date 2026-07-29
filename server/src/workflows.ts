import { randomUUID } from 'node:crypto';
import type {
  PromptAttachment,
  ServerMessage,
  StepContent,
  StepDef,
  StepRef,
  WorkflowDef,
  WorkflowMarkerData,
  WorkflowState,
} from '@lines/shared';
import { isSessionActive, isStepRef } from '@lines/shared';
import type { Store } from './store.ts';
import type { SessionManager } from './sessions.ts';
import { captureBaseline, workingTreeDiff } from './git.ts';

const stepKey = (ownerId: string, id: string, version: number) => `${ownerId}/${id}/${version}`;

/** True when two step contents are identical (version bumps only on content change). */
function sameContent(a: StepContent, b: StepContent): boolean {
  return (
    a.name === b.name &&
    a.promptTemplate === b.promptTemplate &&
    a.model === b.model &&
    a.permissionMode === b.permissionMode &&
    a.autoAdvance === b.autoAdvance &&
    a.freshStart === b.freshStart &&
    (a.outputName ?? '') === (b.outputName ?? '')
  );
}

/**
 * True when a template threads the hand-off in itself — via `{previous}`/`{diff}` or
 * any `{outputs.*}` — so `runStep` must not also auto-prepend it. Tested against the
 * template: after substitution the tokens are gone.
 */
export function usesHandoffTokens(template: string): boolean {
  return /\{previous\}|\{diff\}|\{outputs\./.test(template);
}

const TOKEN_RE = /\{(task|feedback|previous|diff|outputs\.[\w-]+)\}/g;

/**
 * Fill every prompt token in ONE pass over the template. Single-pass is the whole
 * point: staged `replaceAll`s rescan text they just inserted, so a step output that
 * merely *mentions* `{previous}`/`{diff}` (a plan about this very feature, say) gets
 * those tokens expanded too — six literal `{previous}` in a plan meant the plan was
 * pasted seven times and the diff thirty-five, blowing a 3.8 MB prompt past the
 * context limit. `String.replace` never rescans replacement text, so substituted
 * content stays inert.
 *
 * `{outputs.<name>}` resolving to nothing — absent, or present but blank — is
 * reported rather than collapsed to '' silently, which is how a step ends up running
 * without the plan it asked for and improvising from whatever it finds on disk.
 */
export function substituteTokens(
  template: string,
  values: { task: string; feedback: string; previous: string; diff: string },
  outputs: Record<string, string>,
): { prompt: string; missing: string[] } {
  const missing: string[] = [];
  const prompt = template.replace(TOKEN_RE, (_m, token: string) => {
    if (!token.startsWith('outputs.')) return values[token as keyof typeof values];
    const name = token.slice('outputs.'.length);
    const value = outputs[name];
    if (!value || !value.trim()) {
      if (!missing.includes(name)) missing.push(name);
      return '';
    }
    return value;
  });
  return { prompt, missing };
}

export const DEFAULT_WORKFLOW: WorkflowDef = {
  id: 'default-feature-flow',
  name: 'Plan → MVP → Tests → Refactor → Review',
  steps: [
    {
      name: 'Plan',
      promptTemplate:
        'We are starting a new feature: {task}\n\nFirst, explore the codebase and produce a concise implementation plan. Do not write any code yet — plan only. Ask clarifying questions if the goal is ambiguous.{feedback}',
      model: 'claude-opus-5',
      permissionMode: 'plan',
      autoAdvance: false,
      freshStart: false,
    },
    {
      name: 'Implement MVP',
      promptTemplate:
        'Implement the MVP of the planned feature now. Follow the approved plan as supplied in this prompt — that text is the whole plan; never go looking for plan files under ~/.claude/plans/ (they belong to other sessions). Keep the change minimal — no extras beyond the plan.{feedback}',
      model: 'claude-opus-5',
      permissionMode: 'acceptEdits',
      autoAdvance: false,
      freshStart: true,
    },
    {
      name: 'Add tests',
      promptTemplate:
        'Add tests covering the feature just implemented. Run them and make sure they pass.{feedback}',
      model: 'claude-sonnet-5',
      permissionMode: 'acceptEdits',
      autoAdvance: false,
      freshStart: true,
    },
    {
      name: 'Refactor',
      promptTemplate:
        'Refactor the new code for clarity and consistency with the rest of the codebase. Keep tests green.{feedback}',
      model: 'claude-sonnet-5',
      permissionMode: 'acceptEdits',
      autoAdvance: false,
      freshStart: true,
    },
    {
      name: 'Review',
      promptTemplate:
        'Do a final review of everything changed in this session. Look for correctness bugs, missed edge cases, and quality issues. Report findings; do not change code.{feedback}',
      model: 'claude-opus-5',
      permissionMode: 'plan',
      autoAdvance: false,
      freshStart: true,
    },
  ],
};

export class WorkflowEngine {
  private workflows = new Map<string, WorkflowDef>();
  /** Other users' published workflows — read-only, never persisted or pushed. */
  private shared = new Map<string, WorkflowDef>();
  /** This user's own published step heads, keyed by step id. */
  private steps = new Map<string, StepDef>();
  /** Other users' published step heads (the library), keyed `${ownerId}/${id}`. */
  private sharedSteps = new Map<string, StepDef>();
  /** Every resolved immutable version (own history + resolved foreign pins), keyed by stepKey. */
  private stepVersions = new Map<string, StepDef>();
  /** Grace period a force-advance gives the interrupted turn to settle on its own
   *  before the watchdog advances the step anyway. A field so tests can shrink it. */
  forceAdvanceSettleMs = 5_000;
  /** Armed watchdogs, keyed by session (see armSettleWatchdog). */
  private settleWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private store: Store,
    private sessions: SessionManager,
    private broadcast: (msg: ServerMessage) => void,
    /** Owner's Clerk userId, stamped onto workflows this user saves. */
    private userId: string,
  ) {
    for (const wf of this.store.loadWorkflows()) this.workflows.set(wf.id, wf);
    for (const s of this.store.loadSteps()) {
      this.steps.set(s.id, s);
      this.stepVersions.set(stepKey(s.ownerId, s.id, s.version), s);
    }
    // Restore the full immutable history (heads are already in above; older versions add on).
    for (const s of this.store.loadStepVersions()) {
      this.stepVersions.set(stepKey(s.ownerId, s.id, s.version), s);
    }
    if (!this.workflows.has(DEFAULT_WORKFLOW.id)) {
      this.workflows.set(DEFAULT_WORKFLOW.id, DEFAULT_WORKFLOW);
      this.persist();
    }
    // Every settle is forwarded, source included: a user-source turn is normally a
    // no-op here, but it must still be able to consume an explicit force-advance
    // (see onWorkflowTurnComplete).
    sessions.setTurnCompleteListener((sessionId, source) => this.onWorkflowTurnComplete(sessionId, source));
  }

  list(): WorkflowDef[] {
    return [...this.workflows.values()];
  }

  /** This user's view of other users' published workflows. */
  listShared(): WorkflowDef[] {
    return [...this.shared.values()];
  }

  /** Owned first, then shared — resolves a session's attached workflow either way. */
  private resolve(id: string): WorkflowDef | undefined {
    return this.workflows.get(id) ?? this.shared.get(id);
  }

  /** Replace the shared set from a storage pull; returns true if it changed. */
  setShared(list: WorkflowDef[]): boolean {
    const next = new Map(list.filter((w) => w.id).map((w) => [w.id, w] as const));
    if (next.size === this.shared.size && [...next].every(([id, w]) => {
      const cur = this.shared.get(id);
      return cur && (cur.updatedAt ?? 0) === (w.updatedAt ?? 0);
    })) {
      return false;
    }
    this.shared = next;
    return true;
  }

  // ---- steps (versioned, shareable) ----

  listSteps(): StepDef[] {
    return [...this.steps.values()];
  }

  listSharedSteps(): StepDef[] {
    return [...this.sharedSteps.values()];
  }

  /** Every immutable version this user owns — the durable history (not just heads). */
  listOwnStepVersions(): StepDef[] {
    return [...this.stepVersions.values()].filter((s) => s.ownerId === this.userId);
  }

  /** Every pin referenced by this user's own workflows, resolved to its immutable version. */
  listPinnedSteps(): StepDef[] {
    const out: StepDef[] = [];
    for (const ref of this.refs()) {
      const s = this.stepVersions.get(stepKey(ref.ownerId, ref.stepId, ref.version));
      if (s) out.push(s);
    }
    return out;
  }

  /** Distinct step refs across all owned workflows. */
  private refs(): StepRef[] {
    const seen = new Map<string, StepRef>();
    for (const wf of this.workflows.values()) {
      for (const step of wf.steps) {
        if (isStepRef(step)) seen.set(stepKey(step.ownerId, step.stepId, step.version), step);
      }
    }
    return [...seen.values()];
  }

  /** Refs whose pinned version isn't cached yet — userContext resolves these from storage. */
  unresolvedRefs(): StepRef[] {
    return this.refs().filter((r) => !this.stepVersions.has(stepKey(r.ownerId, r.stepId, r.version)));
  }

  /** Adopt resolved immutable versions (own history from a pull, or foreign pins). */
  addStepVersions(list: StepDef[]): void {
    for (const s of list) this.stepVersions.set(stepKey(s.ownerId, s.id, s.version), s);
  }

  /** Cached versions of one step, newest first (best-effort local view). */
  listStepVersions(ownerId: string, stepId: string): StepDef[] {
    return [...this.stepVersions.values()]
      .filter((s) => s.ownerId === ownerId && s.id === stepId)
      .sort((a, b) => b.version - a.version);
  }

  /** Replace the shared-step library; returns true if it changed. */
  setSharedSteps(list: StepDef[]): boolean {
    const next = new Map(list.filter((s) => s.id && s.ownerId).map((s) => [`${s.ownerId}/${s.id}`, s] as const));
    const changed =
      next.size !== this.sharedSteps.size ||
      [...next].some(([k, s]) => (this.sharedSteps.get(k)?.version ?? -1) !== s.version);
    this.sharedSteps = next;
    // Library heads are resolvable versions too.
    for (const s of next.values()) this.stepVersions.set(stepKey(s.ownerId, s.id, s.version), s);
    return changed;
  }

  /** Adopt own steps pulled from storage (LWW on version). */
  applySyncedSteps(list: StepDef[]): void {
    let changed = false;
    for (const s of list) {
      const cur = this.steps.get(s.id);
      if (!cur || s.version >= cur.version) {
        this.steps.set(s.id, s);
        this.stepVersions.set(stepKey(s.ownerId, s.id, s.version), s);
        changed = true;
      }
    }
    if (changed) this.persistSteps();
  }

  /**
   * Save or update a step. A content change bumps the (immutable) version;
   * toggling `published` alone keeps the version and just re-flags the head.
   */
  saveStep(content: StepContent, stepId: string | undefined, published: boolean, ownerName: string | undefined): StepDef {
    const id = stepId && this.steps.has(stepId) ? stepId : stepId || randomUUID();
    const head = this.steps.get(id);
    const contentChanged = !head || !sameContent(head, content);
    const version = head ? (contentChanged ? head.version + 1 : head.version) : 1;
    const step: StepDef = {
      ...content,
      id,
      ownerId: this.userId,
      ownerName,
      version,
      published,
      updatedAt: Date.now(),
    };
    this.steps.set(id, step);
    this.stepVersions.set(stepKey(step.ownerId, id, version), step);
    this.persistSteps();
    this.broadcast({ type: 'steps', steps: this.listSteps() });
    return step;
  }

  /** Drop a step from this user's library; immutable versions stay cached for existing pins. */
  deleteStep(stepId: string): void {
    if (!this.steps.delete(stepId)) return;
    this.persistSteps();
    this.broadcast({ type: 'steps', steps: this.listSteps() });
  }

  private persistSteps() {
    this.store.saveSteps(this.listSteps());
    // Heads alone would lose intermediate versions across a restart; persist the full history too.
    this.store.saveStepVersions(this.listOwnStepVersions());
  }

  /** Resolve a workflow step to its runnable content (refs → pinned immutable version). */
  private stepContent(step: WorkflowDef['steps'][number]): StepContent | undefined {
    if (!isStepRef(step)) return step;
    return this.stepVersions.get(stepKey(step.ownerId, step.stepId, step.version));
  }

  save(workflow: WorkflowDef): WorkflowDef {
    // A shared (foreign) workflow is read-only: saving its id would fork it under
    // this user silently. Duplicating instead arrives with a fresh (empty) id.
    if (workflow.id && !this.workflows.has(workflow.id) && this.shared.has(workflow.id)) {
      return workflow;
    }
    if (!workflow.id) workflow.id = randomUUID();
    workflow.updatedAt = Date.now(); // LWW key for cross-instance sync
    workflow.ownerId = this.userId; // authoritative — never trust a client-sent owner
    this.workflows.set(workflow.id, workflow);
    this.persist();
    this.broadcast({ type: 'workflows', workflows: this.list() });
    return workflow;
  }

  /**
   * Adopt a batch of workflows pulled from the storage server — LWW on
   * updatedAt, no restamp. One persist and one broadcast for the whole batch:
   * a per-workflow broadcast made a sync fan a shared re-pull out to every
   * other live user context once per adopted row.
   */
  applySyncedAll(list: WorkflowDef[]) {
    let changed = false;
    for (const workflow of list) {
      const cur = this.workflows.get(workflow.id);
      if (cur && (workflow.updatedAt ?? 0) <= (cur.updatedAt ?? 0)) continue;
      this.workflows.set(workflow.id, workflow);
      changed = true;
    }
    if (!changed) return;
    this.persist();
    this.broadcast({ type: 'workflows', workflows: this.list() });
  }

  delete(workflowId: string) {
    this.workflows.delete(workflowId);
    this.persist();
    this.broadcast({ type: 'workflows', workflows: this.list() });
  }

  private persist() {
    this.store.saveWorkflows(this.list());
  }

  /** Attach a workflow to a session; it starts on the user's first prompt (the task description). */
  attach(sessionId: string, workflowId: string) {
    const meta = this.sessions.get(sessionId);
    const wf = this.resolve(workflowId);
    if (!meta || !wf) return;
    meta.workflow = {
      workflowId,
      stepIndex: 0,
      stepStatuses: wf.steps.map(() => 'pending'),
      started: false,
    } satisfies WorkflowState;
    // Reflect step 0's mode/model on the session up front so the composer pill is
    // correct before the first prompt. runStep re-applies these (via the worker) on start.
    const step0 = wf.steps[0] && this.stepContent(wf.steps[0]);
    if (step0) {
      meta.permissionMode = step0.permissionMode;
      meta.model = step0.model;
      meta.workflow.stepPermissionMode = step0.permissionMode;
    }
    this.sessions.setStatus(sessionId, meta.status); // persist + broadcast the attached workflow
  }

  /**
   * Returns true if this prompt was consumed as the workflow's task description
   * (i.e. it kicked off step 0); false means the caller should treat it as normal chat.
   */
  startIfPending(sessionId: string, userText: string, attachments?: PromptAttachment[]): boolean {
    const meta = this.sessions.get(sessionId);
    if (!meta?.workflow || meta.workflow.started) return false;
    meta.workflow.started = true;
    meta.workflow.task = userText;
    this.sessions.maybeAutoName(sessionId, userText);
    // Snapshot the working tree now so later steps' {diff} excludes pre-existing
    // dirty state. Fire-and-forget: the first fresh step is at least one approval
    // gap away, long after this resolves.
    void this.captureDiffBaseline(sessionId);
    void this.runStep(sessionId, undefined, true, attachments);
    return true;
  }

  private async captureDiffBaseline(sessionId: string) {
    const meta = this.sessions.get(sessionId);
    if (!meta?.workflow) return;
    meta.workflow.diffBaseline = await captureBaseline(meta.cwd);
  }

  private marker(sessionId: string, data: WorkflowMarkerData) {
    this.sessions.emitEvent(sessionId, 'workflow', data);
  }

  /**
   * @param entry True when first entering the step (start/advance/approve) — the
   *   point where a fresh-start step resets its session and gets the hand-off.
   *   False on retry/iterate, which stay in the step's existing (fresh or
   *   inherited) conversation so feedback lands on the same context.
   */
  private async runStep(
    sessionId: string,
    feedback?: string,
    entry = false,
    /** Attachments the user sent with the task description — entry step only. */
    attachments?: PromptAttachment[],
  ) {
    const meta = this.sessions.get(sessionId);
    const wf = meta?.workflow && this.resolve(meta.workflow.workflowId);
    if (!meta || !meta.workflow || !wf) {
      // `advance` clears `advancing` without its own broadcast, riding whatever this
      // call broadcasts next — so a return that broadcasts nothing leaves the client's
      // loader spinning forever on a stale flag.
      this.sessions.persistMeta(sessionId);
      return;
    }
    const i = meta.workflow.stepIndex;
    const step = wf.steps[i];
    const content = step && this.stepContent(step);
    if (!step || !content) {
      // Unresolved reference (e.g. a shared step version this bridge couldn't fetch).
      if (step) {
        // Status set first: setStatus is what broadcasts, so a later mutation would
        // only reach the client on the next unrelated message.
        meta.workflow.stepStatuses[i] = 'waiting-approval';
        this.sessions.setStatus(sessionId, 'error');
      } else {
        // Index past the last step (a workflow edited shorter mid-run, say): nothing
        // to run, but the bumped stepIndex and the cleared `advancing` still have to
        // reach the client.
        this.sessions.persistMeta(sessionId);
      }
      return;
    }

    meta.workflow.stepStatuses[i] = 'running';
    meta.workflow.stepPermissionMode = content.permissionMode;
    // Clear any stale waiting-approval status before the async model/mode setup below.
    this.sessions.setStatus(sessionId, 'running');
    this.marker(sessionId, {
      stepIndex: i,
      stepName: content.name,
      event: feedback !== undefined ? 'retried' : 'started',
      feedback,
    });

    // Per-step model + permission mode take effect before the prompt is queued.
    await this.sessions.setModel(sessionId, content.model);
    await this.sessions.setPermissionMode(sessionId, content.permissionMode);

    const feedbackText = feedback
      ? `\n\nThe user reviewed the previous attempt at this step and asked for changes: ${feedback}`
      : '';
    // Hand-off tokens are looked for in the *template*: after substitution they are
    // gone, and substituted output text can itself contain a literal {previous}.
    // A template pulling {outputs.*} already carries its context, so the
    // auto-prepend below must not inject the same text a second time.
    const usesTokens = usesHandoffTokens(content.promptTemplate);

    // Fresh start: drop the accumulated conversation and seed a clean session
    // with a compact hand-off — the previous step's final output ({previous},
    // e.g. a plan) and the working-tree diff ({diff}). Only when entering a step
    // that actually has predecessors (i > 0); step 0 has no prior output and its
    // "diff" would just be the repo's pre-existing dirty state. Retries stay in
    // the fresh session already established for this step.
    const handoff = content.freshStart && entry && i > 0;
    const previous = handoff
      ? (meta.workflow.lastStepOutput ?? this.sessions.lastAssistantText(sessionId))
      : '';
    const diff = handoff ? await workingTreeDiff(meta.cwd, meta.workflow.diffBaseline) : '';

    // Every token is filled in one pass over the *template*, so text pulled in by
    // one token can never be rescanned for another (see substituteTokens). An
    // unresolved {outputs.<name>} parks the step instead of running it blind.
    const base = content.promptTemplate.includes('{feedback}')
      ? content.promptTemplate
      : content.promptTemplate + '{feedback}';
    const resolved = substituteTokens(
      base,
      { task: meta.workflow.task ?? '', feedback: feedbackText, previous, diff },
      meta.workflow.outputs ?? {},
    );
    let prompt = resolved.prompt;
    if (resolved.missing.length) {
      meta.workflow.stepStatuses[i] = 'waiting-approval';
      this.sessions.setStatus(sessionId, 'error');
      this.marker(sessionId, {
        stepIndex: i,
        stepName: content.name,
        event: 'waiting-approval',
        missingOutputs: resolved.missing,
      });
      return;
    }

    if (handoff) {
      // A template pulling {outputs.*} (or the hand-off tokens directly) already
      // carries its context — auto-prepending would inject the same text twice.
      if (!usesTokens) {
        const parts: string[] = [];
        if (previous) parts.push(`## Context from the previous step\n\n${previous}`);
        if (diff) parts.push(`## Changes so far (git diff)\n\n\`\`\`diff\n${diff}\n\`\`\``);
        if (parts.length) prompt = `${parts.join('\n\n')}\n\n---\n\n${prompt}`;
      }
      this.sessions.resetClaudeSession(sessionId);
    } else if (content.freshStart && entry) {
      // Nothing to hand off (a fresh first step) — still start from a clean session.
      this.sessions.resetClaudeSession(sessionId);
    }

    this.sessions.prompt(sessionId, prompt, 'workflow', attachments);
  }

  /** Resolved step name for transcript markers ('' if a ref couldn't be resolved). */
  private stepName(step?: WorkflowDef['steps'][number]): string {
    return (step && this.stepContent(step)?.name) || '';
  }

  private onWorkflowTurnComplete(sessionId: string, source: 'user' | 'workflow') {
    const meta = this.sessions.get(sessionId);
    const wf = meta?.workflow && this.resolve(meta.workflow.workflowId);
    if (!meta || !meta.workflow || !wf) return;
    const i = meta.workflow.stepIndex;
    const step = wf.steps[i];
    if (!step || meta.workflow.stepStatuses[i] !== 'running') return;

    // A pending advance only counts for the step it was flagged for: an abandoned
    // turn settling late (see the force-advance watchdog) must not advance or park
    // whatever step is current by then. Metas from an older build carry no stamp.
    const stamped = (meta.workflow.advanceOnCompleteStep ?? i) === i;
    const forced = meta.workflow.advanceOnComplete === 'interrupted' && stamped;
    // A user-source turn can be live while the step still reads 'running' (a worker
    // error skipped the settle, then the user typed). It does nothing here except
    // consume an explicit force-advance stamped for this step — otherwise that step
    // would sit at 'running' forever.
    if (source !== 'workflow' && !forced) return;

    if (source === 'workflow') {
      // Accumulate this turn's cost onto the step (retries add to the same slot).
      const cost = meta.lastCostUsd;
      if (typeof cost === 'number') {
        const costs = (meta.workflow.stepCostsUsd ??= []);
        costs[i] = (costs[i] ?? 0) + cost;
      }

      // Same accumulation for tokens (retries add to the same slot).
      const tokens = meta.lastTokens;
      if (typeof tokens === 'number') {
        const stepTokens = (meta.workflow.stepTokens ??= []);
        stepTokens[i] = (stepTokens[i] ?? 0) + tokens;
      }

      // Same accumulation for active-turn duration (retries add to the same slot).
      const durationMs = meta.lastDurationMs;
      if (typeof durationMs === 'number') {
        const durations = (meta.workflow.stepDurationsMs ??= []);
        durations[i] = (durations[i] ?? 0) + durationMs;
      }
    }

    // A plan approved mid-step — or a force-advance of a running step — advances
    // straight to the next step. A plain Stop parks below instead.
    if (meta.workflow.advanceOnComplete && stamped) {
      const event = meta.workflow.advanceOnComplete === 'interrupted' ? 'interrupted' : 'approved';
      meta.workflow.advanceOnComplete = undefined;
      meta.workflow.advanceOnCompleteStep = undefined;
      this.clearSettleWatchdog(sessionId); // a normal settle disarms the watchdog
      this.marker(sessionId, { stepIndex: i, stepName: this.stepName(step), event });
      void this.advance(sessionId);
      return;
    }

    if (this.stepContent(step)?.autoAdvance) {
      void this.advance(sessionId);
      return;
    }

    // A follow-up the user sent while the step was still running supersedes the
    // park: re-run the same step with it instead of stranding it in the queue.
    const queued = this.sessions.takeQueuedText(sessionId);
    if (queued) {
      this.iterateStep(sessionId, queued.text, queued.attachments);
      return;
    }

    meta.workflow.stepStatuses[i] = 'waiting-approval';
    this.sessions.setStatus(sessionId, 'waiting-approval');
    this.marker(sessionId, { stepIndex: i, stepName: this.stepName(step), event: 'waiting-approval' });
  }

  /**
   * A free-text prompt sent while a step is parked at waiting-approval iterates
   * on the SAME step (never advances). Returns true if it consumed the prompt.
   */
  iterateIfWaiting(sessionId: string, text: string, attachments?: PromptAttachment[]): boolean {
    const meta = this.sessions.get(sessionId);
    if (!meta?.workflow) return false;
    const i = meta.workflow.stepIndex;
    if (meta.workflow.stepStatuses[i] !== 'waiting-approval') return false;
    this.iterateStep(sessionId, text, attachments);
    return true;
  }

  /** Re-run the current step as a plain follow-up turn (same conversation, no advance). */
  private iterateStep(sessionId: string, text: string, attachments?: PromptAttachment[]) {
    const meta = this.sessions.get(sessionId);
    const wf = meta?.workflow && this.resolve(meta.workflow.workflowId);
    if (!meta || !meta.workflow || !wf) return;
    const i = meta.workflow.stepIndex;
    meta.workflow.stepStatuses[i] = 'running';
    this.sessions.setStatus(sessionId, 'running');
    this.marker(sessionId, {
      stepIndex: i,
      stepName: this.stepName(wf.steps[i]),
      event: 'retried',
    });
    this.sessions.prompt(sessionId, text, 'workflow', attachments);
  }

  approve(sessionId: string, stepIndex: number) {
    const meta = this.sessions.get(sessionId);
    if (!meta?.workflow) return;
    const i = meta.workflow.stepIndex;
    // Ignore a stale approve (e.g. a duplicate or a second tab showing an old
    // card): only act when it targets the step that is actually parked now.
    if (stepIndex !== i) return;
    if (meta.workflow.stepStatuses[i] !== 'waiting-approval') return;
    const wf = this.resolve(meta.workflow.workflowId);
    this.marker(sessionId, {
      stepIndex: i,
      stepName: this.stepName(wf?.steps[i]),
      event: 'approved',
    });
    void this.advance(sessionId);
  }

  /**
   * "Mark as completed" from the stepper. A parked step takes the same path as
   * Approve. A still-running step flags `advanceOnComplete` here and then stops
   * the turn, so the advance happens only once that turn settles; advancing under
   * a live turn lets the old query's late result clobber the next step. `interrupt()`
   * itself implies nothing (see docs/codebase/features/workflow-stop-parks.md).
   *
   * The flag is stamped with the step it was raised for, so a settle for any other
   * step ignores it — and a watchdog advances anyway if no settle ever arrives. One
   * click must always end on the next step.
   */
  forceAdvance(sessionId: string, stepIndex: number) {
    const meta = this.sessions.get(sessionId);
    if (!meta?.workflow?.started) return;
    const i = meta.workflow.stepIndex;
    // Ignore a stale click (duplicate, or a second tab showing an older stepper).
    if (stepIndex !== i) return;
    const status = meta.workflow.stepStatuses[i];
    if (status === 'waiting-approval') {
      this.approve(sessionId, i);
      return;
    }
    if (status !== 'running') return;
    if (isSessionActive(meta.status)) {
      // Flagged whatever the turn's source: a user-source turn can be live while the
      // step still reads 'running' (a worker error skipped the settle, then the user
      // typed), and refusing to flag there left the step stranded at 'running'
      // forever. The step stamp — not the turn source — is what keeps a stale flag
      // from skipping a later step's park.
      meta.workflow.advanceOnComplete = 'interrupted';
      meta.workflow.advanceOnCompleteStep = i;
      this.sessions.interrupt(sessionId);
      this.armSettleWatchdog(sessionId, i);
      return;
    }
    // Marked running with no turn in flight (e.g. the worker died mid-step): no
    // late result can arrive, so advance straight away.
    const wf = this.resolve(meta.workflow.workflowId);
    this.marker(sessionId, {
      stepIndex: i,
      stepName: this.stepName(wf?.steps[i]),
      event: 'approved',
    });
    void this.advance(sessionId);
  }

  /**
   * "Start this step" from the stepper. An advance can land on a step without ever
   * queueing its first turn — the bridge died mid-advance, or runStep bailed — and
   * then the step sits 'pending' with nothing in flight, so no settle is ever coming
   * to move it. Runs it as a normal step entry, hand-off included, so it proceeds
   * exactly as the advance would have.
   */
  startStep(sessionId: string, stepIndex: number) {
    const meta = this.sessions.get(sessionId);
    // Before the first prompt there is no task to substitute — that prompt starts step 0.
    if (!meta?.workflow?.started) return;
    const i = meta.workflow.stepIndex;
    // Ignore a stale click (duplicate, or a second tab showing an older stepper).
    if (stepIndex !== i) return;
    // Only a step that never started: 'running' belongs to forceAdvance, and a parked
    // step to approve/retry.
    if (meta.workflow.stepStatuses[i] !== 'pending') return;
    // A live turn or an advance mid-consolidation is already on its way to starting it.
    if (isSessionActive(meta.status) || meta.workflow.advancing) return;
    void this.runStep(sessionId, undefined, true);
  }

  /**
   * A force-advance hands the advance to whatever settles the interrupted turn — a
   * `result`, or an `ended` for a query that dies without one. A wedged worker emits
   * neither, and the step would then sit at 'running' forever, so advance it here.
   *
   * Clearing `turnSource` is load-bearing: a very late result from the abandoned turn
   * then settles as 'user' with the stamp already consumed, which onWorkflowTurnComplete
   * ignores — so it can neither advance nor park the *next* step.
   */
  private armSettleWatchdog(sessionId: string, i: number) {
    this.clearSettleWatchdog(sessionId);
    const timer = setTimeout(() => {
      this.settleWatchdogs.delete(sessionId);
      const meta = this.sessions.get(sessionId);
      const wf = meta?.workflow && this.resolve(meta.workflow.workflowId);
      if (!meta || !meta.workflow || !wf) return;
      // Bail unless nothing has moved since the click: the flag is still ours, the
      // step is still the current running one, and no turn is live — a session back
      // to active means the user (or a recovery path) re-prompted, and that turn's own
      // settle owns the advance.
      if (meta.workflow.advanceOnComplete !== 'interrupted') return;
      if (meta.workflow.advanceOnCompleteStep !== i) return;
      if (meta.workflow.stepIndex !== i) return;
      if (meta.workflow.stepStatuses[i] !== 'running') return;
      if (isSessionActive(meta.status)) return;
      meta.turnSource = undefined;
      meta.workflow.advanceOnComplete = undefined;
      meta.workflow.advanceOnCompleteStep = undefined;
      this.marker(sessionId, {
        stepIndex: i,
        stepName: this.stepName(wf.steps[i]),
        event: 'interrupted',
      });
      void this.advance(sessionId);
    }, this.forceAdvanceSettleMs);
    timer.unref?.(); // never hold the process open on a pending advance
    this.settleWatchdogs.set(sessionId, timer);
  }

  private clearSettleWatchdog(sessionId: string) {
    const timer = this.settleWatchdogs.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.settleWatchdogs.delete(sessionId);
  }

  retry(sessionId: string, stepIndex: number, feedback: string) {
    const meta = this.sessions.get(sessionId);
    if (!meta?.workflow) return;
    const i = meta.workflow.stepIndex;
    if (stepIndex !== i) return;
    if (meta.workflow.stepStatuses[i] !== 'waiting-approval') return;
    void this.runStep(sessionId, feedback);
  }

  private async advance(sessionId: string) {
    const meta = this.sessions.get(sessionId);
    const wf = meta?.workflow && this.resolve(meta.workflow.workflowId);
    if (!meta || !meta.workflow || !wf) return;
    const i = meta.workflow.stepIndex;
    meta.workflow.stepStatuses[i] = 'done';
    // Consolidating an iterated step runs a real query, so the gap before the next
    // step starts is seconds long with nothing else broadcast in it. Raise the
    // in-flight flag *before* the await — every path from the WS handler to here is
    // synchronous, so the client sees it in the same tick as the click.
    meta.workflow.advancing = true;
    this.sessions.persistMeta(sessionId);

    try {
      // Consolidate this step's final output (single-turn steps return their last
      // text as-is; iterated steps fold every attempt into one deliverable). Kept
      // for the {previous} hand-off, and published under the step's name so later
      // steps can pull it via {outputs.<name>}.
      const output = await this.sessions.consolidateStepOutput(sessionId, i);
      // An empty capture is not a deliverable — publishing it would clobber a
      // previous non-empty value and hand the next step nothing.
      if (output.trim()) {
        meta.workflow.lastStepOutput = output;
        const outName = this.stepContent(wf.steps[i])?.outputName?.trim();
        if (outName) {
          (meta.workflow.outputs ??= {})[outName] = output;
        }
        // Persist the capture before the next step is queued: otherwise it rides on
        // whatever setStatus happens next and is lost if the bridge dies in between.
        this.sessions.persistMeta(sessionId);
      }
    } catch (err) {
      // consolidateStepOutput catches internally, so this is insurance only. Swallowed
      // rather than rethrown: every caller does `void this.advance(...)`, so a rejection
      // here would be an unhandled rejection — and the flow below still clears the
      // in-flight flag and starts the next step, which beats a stuck loader.
      console.warn('[workflow advance]', err);
    }

    // Cleared without its own broadcast: both branches below broadcast next with no
    // await in between (runStep's setStatus('running') / its error branch, or the
    // final setStatus('idle')), so the clear rides that message and the button never
    // flickers back to live. An await inserted between here and those calls reopens
    // that window.
    meta.workflow.advancing = false;

    if (i + 1 < wf.steps.length) {
      meta.workflow.stepIndex = i + 1;
      void this.runStep(sessionId, undefined, true);
    } else {
      this.sessions.setStatus(sessionId, 'idle');
      this.marker(sessionId, {
        stepIndex: i,
        stepName: this.stepName(wf.steps[i]),
        event: 'workflow-done',
      });
    }
  }
}
