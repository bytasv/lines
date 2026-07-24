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
import { isStepRef } from '@lines/shared';
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

export const DEFAULT_WORKFLOW: WorkflowDef = {
  id: 'default-feature-flow',
  name: 'Plan → MVP → Tests → Refactor → Review',
  steps: [
    {
      name: 'Plan',
      promptTemplate:
        'We are starting a new feature: {task}\n\nFirst, explore the codebase and produce a concise implementation plan. Do not write any code yet — plan only. Ask clarifying questions if the goal is ambiguous.{feedback}',
      model: 'claude-opus-4-8',
      permissionMode: 'plan',
      autoAdvance: false,
      freshStart: false,
    },
    {
      name: 'Implement MVP',
      promptTemplate:
        'Implement the MVP of the planned feature now. Follow the approved plan. Keep the change minimal — no extras beyond the plan.{feedback}',
      model: 'claude-opus-4-8',
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
      model: 'claude-opus-4-8',
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
    sessions.setTurnCompleteListener((sessionId, source) => {
      if (source === 'workflow') this.onWorkflowTurnComplete(sessionId);
    });
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

  /** Adopt a workflow pulled from the storage server — LWW on updatedAt, no restamp. */
  applySynced(workflow: WorkflowDef) {
    const cur = this.workflows.get(workflow.id);
    if (cur && (workflow.updatedAt ?? 0) <= (cur.updatedAt ?? 0)) return;
    this.workflows.set(workflow.id, workflow);
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
  startIfPending(sessionId: string, userText: string): boolean {
    const meta = this.sessions.get(sessionId);
    if (!meta?.workflow || meta.workflow.started) return false;
    meta.workflow.started = true;
    meta.workflow.task = userText;
    this.sessions.maybeAutoName(sessionId, userText);
    // Snapshot the working tree now so later steps' {diff} excludes pre-existing
    // dirty state. Fire-and-forget: the first fresh step is at least one approval
    // gap away, long after this resolves.
    void this.captureDiffBaseline(sessionId);
    void this.runStep(sessionId, undefined, true);
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
  private async runStep(sessionId: string, feedback?: string, entry = false) {
    const meta = this.sessions.get(sessionId);
    const wf = meta?.workflow && this.resolve(meta.workflow.workflowId);
    if (!meta || !meta.workflow || !wf) return;
    const i = meta.workflow.stepIndex;
    const step = wf.steps[i];
    const content = step && this.stepContent(step);
    if (!step || !content) {
      // Unresolved reference (e.g. a shared step version this bridge couldn't fetch).
      if (step) {
        this.sessions.setStatus(sessionId, 'error');
        meta.workflow.stepStatuses[i] = 'waiting-approval';
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
    let prompt = content.promptTemplate.includes('{feedback}')
      ? content.promptTemplate.replaceAll('{feedback}', feedbackText)
      : content.promptTemplate + feedbackText;
    prompt = prompt.replaceAll('{task}', meta.workflow.task ?? '');

    // Named outputs from earlier steps: {outputs.<name>} → the captured text
    // (empty string if that step hasn't run yet or wasn't named). Works for
    // both fresh and inherited steps.
    const outputs = meta.workflow.outputs ?? {};
    prompt = prompt.replace(/\{outputs\.([\w-]+)\}/g, (_m, name: string) => outputs[name] ?? '');

    // Fresh start: drop the accumulated conversation and seed a clean session
    // with a compact hand-off — the previous step's final output ({previous},
    // e.g. a plan) and the working-tree diff ({diff}). Only when entering a step
    // that actually has predecessors (i > 0); step 0 has no prior output and its
    // "diff" would just be the repo's pre-existing dirty state. Retries stay in
    // the fresh session already established for this step.
    if (content.freshStart && entry && i > 0) {
      const previous = meta.workflow.lastStepOutput ?? this.sessions.lastAssistantText(sessionId);
      const diff = await workingTreeDiff(meta.cwd, meta.workflow.diffBaseline);
      const usesTokens = prompt.includes('{previous}') || prompt.includes('{diff}');
      prompt = prompt.replaceAll('{previous}', previous).replaceAll('{diff}', diff);
      if (!usesTokens) {
        const parts: string[] = [];
        if (previous) parts.push(`## Context from the previous step\n\n${previous}`);
        if (diff) parts.push(`## Changes so far (git diff)\n\n\`\`\`diff\n${diff}\n\`\`\``);
        if (parts.length) prompt = `${parts.join('\n\n')}\n\n---\n\n${prompt}`;
      }
      this.sessions.resetClaudeSession(sessionId);
    } else {
      // No hand-off to fill (non-fresh, a retry, or the first step): strip the
      // tokens. A fresh first step still gets a clean session below.
      prompt = prompt.replaceAll('{previous}', '').replaceAll('{diff}', '');
      if (content.freshStart && entry) this.sessions.resetClaudeSession(sessionId);
    }

    this.sessions.prompt(sessionId, prompt, 'workflow');
  }

  /** Resolved step name for transcript markers ('' if a ref couldn't be resolved). */
  private stepName(step?: WorkflowDef['steps'][number]): string {
    return (step && this.stepContent(step)?.name) || '';
  }

  private onWorkflowTurnComplete(sessionId: string) {
    const meta = this.sessions.get(sessionId);
    const wf = meta?.workflow && this.resolve(meta.workflow.workflowId);
    if (!meta || !meta.workflow || !wf) return;
    const i = meta.workflow.stepIndex;
    const step = wf.steps[i];
    if (!step || meta.workflow.stepStatuses[i] !== 'running') return;

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

    // A plan approved mid-step — or a manual Stop — advances straight to the next step.
    if (meta.workflow.advanceOnComplete) {
      const event = meta.workflow.advanceOnComplete === 'interrupted' ? 'interrupted' : 'approved';
      meta.workflow.advanceOnComplete = undefined;
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

    // Consolidate this step's final output (single-turn steps return their last
    // text as-is; iterated steps fold every attempt into one deliverable). Kept
    // for the {previous} hand-off, and published under the step's name so later
    // steps can pull it via {outputs.<name>}.
    const output = await this.sessions.consolidateStepOutput(sessionId);
    meta.workflow.lastStepOutput = output;
    const outName = this.stepContent(wf.steps[i])?.outputName?.trim();
    if (outName) {
      (meta.workflow.outputs ??= {})[outName] = output;
    }

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
