import { randomUUID } from 'node:crypto';
import type { PromptAttachment, ServerMessage, WorkflowDef, WorkflowMarkerData, WorkflowState } from '@claude-ui/shared';
import { store } from './store.ts';
import type { SessionManager } from './sessions.ts';

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
    },
    {
      name: 'Implement MVP',
      promptTemplate:
        'Implement the MVP of the planned feature now. Follow the approved plan. Keep the change minimal — no extras beyond the plan.{feedback}',
      model: 'claude-opus-4-8',
      permissionMode: 'acceptEdits',
      autoAdvance: false,
    },
    {
      name: 'Add tests',
      promptTemplate:
        'Add tests covering the feature just implemented. Run them and make sure they pass.{feedback}',
      model: 'claude-sonnet-5',
      permissionMode: 'acceptEdits',
      autoAdvance: false,
    },
    {
      name: 'Refactor',
      promptTemplate:
        'Refactor the new code for clarity and consistency with the rest of the codebase. Keep tests green.{feedback}',
      model: 'claude-sonnet-5',
      permissionMode: 'acceptEdits',
      autoAdvance: false,
    },
    {
      name: 'Review',
      promptTemplate:
        'Do a final review of everything changed in this session. Look for correctness bugs, missed edge cases, and quality issues. Report findings; do not change code.{feedback}',
      model: 'claude-opus-4-8',
      permissionMode: 'plan',
      autoAdvance: false,
    },
  ],
};

export class WorkflowEngine {
  private workflows = new Map<string, WorkflowDef>();

  constructor(
    private sessions: SessionManager,
    private broadcast: (msg: ServerMessage) => void,
  ) {
    for (const wf of store.loadWorkflows()) this.workflows.set(wf.id, wf);
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

  save(workflow: WorkflowDef): WorkflowDef {
    if (!workflow.id) workflow.id = randomUUID();
    this.workflows.set(workflow.id, workflow);
    this.persist();
    this.broadcast({ type: 'workflows', workflows: this.list() });
    return workflow;
  }

  delete(workflowId: string) {
    this.workflows.delete(workflowId);
    this.persist();
    this.broadcast({ type: 'workflows', workflows: this.list() });
  }

  private persist() {
    store.saveWorkflows(this.list());
  }

  /** Attach a workflow to a session; it starts on the user's first prompt (the task description). */
  attach(sessionId: string, workflowId: string) {
    const meta = this.sessions.get(sessionId);
    const wf = this.workflows.get(workflowId);
    if (!meta || !wf) return;
    meta.workflow = {
      workflowId,
      stepIndex: 0,
      stepStatuses: wf.steps.map(() => 'pending'),
      started: false,
    } satisfies WorkflowState;
    // Reflect step 0's mode/model on the session up front so the composer pill is
    // correct before the first prompt. runStep re-applies these (via the worker) on start.
    const step0 = wf.steps[0];
    if (step0) {
      meta.permissionMode = step0.permissionMode;
      meta.model = step0.model;
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
    void this.runStep(sessionId);
    return true;
  }

  private marker(sessionId: string, data: WorkflowMarkerData) {
    this.sessions.emitEvent(sessionId, 'workflow', data);
  }

  private async runStep(sessionId: string, feedback?: string) {
    const meta = this.sessions.get(sessionId);
    const wf = meta?.workflow && this.workflows.get(meta.workflow.workflowId);
    if (!meta || !meta.workflow || !wf) return;
    const i = meta.workflow.stepIndex;
    const step = wf.steps[i];
    if (!step) return;

    meta.workflow.stepStatuses[i] = 'running';
    // Clear any stale waiting-approval status before the async model/mode setup below.
    this.sessions.setStatus(sessionId, 'running');
    this.marker(sessionId, {
      stepIndex: i,
      stepName: step.name,
      event: feedback !== undefined ? 'retried' : 'started',
      feedback,
    });

    // Per-step model + permission mode take effect before the prompt is queued.
    await this.sessions.setModel(sessionId, step.model);
    await this.sessions.setPermissionMode(sessionId, step.permissionMode);

    const feedbackText = feedback
      ? `\n\nThe user reviewed the previous attempt at this step and asked for changes: ${feedback}`
      : '';
    let prompt = step.promptTemplate.includes('{feedback}')
      ? step.promptTemplate.replaceAll('{feedback}', feedbackText)
      : step.promptTemplate + feedbackText;
    prompt = prompt.replaceAll('{task}', meta.workflow.task ?? '');

    this.sessions.prompt(sessionId, prompt, 'workflow');
  }

  private onWorkflowTurnComplete(sessionId: string) {
    const meta = this.sessions.get(sessionId);
    const wf = meta?.workflow && this.workflows.get(meta.workflow.workflowId);
    if (!meta || !meta.workflow || !wf) return;
    const i = meta.workflow.stepIndex;
    const step = wf.steps[i];
    if (!step || meta.workflow.stepStatuses[i] !== 'running') return;

    // A plan approved mid-step advances straight to the next step.
    if (meta.workflow.advanceOnComplete) {
      meta.workflow.advanceOnComplete = undefined;
      this.marker(sessionId, { stepIndex: i, stepName: step.name, event: 'approved' });
      this.advance(sessionId);
      return;
    }

    if (step.autoAdvance) {
      this.advance(sessionId);
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
    this.marker(sessionId, { stepIndex: i, stepName: step.name, event: 'waiting-approval' });
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
    const wf = meta?.workflow && this.workflows.get(meta.workflow.workflowId);
    if (!meta || !meta.workflow || !wf) return;
    const i = meta.workflow.stepIndex;
    meta.workflow.stepStatuses[i] = 'running';
    this.sessions.setStatus(sessionId, 'running');
    this.marker(sessionId, {
      stepIndex: i,
      stepName: wf.steps[i]?.name ?? '',
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
    const wf = this.workflows.get(meta.workflow.workflowId);
    this.marker(sessionId, {
      stepIndex: i,
      stepName: wf?.steps[i]?.name ?? '',
      event: 'approved',
    });
    this.advance(sessionId);
  }

  retry(sessionId: string, stepIndex: number, feedback: string) {
    const meta = this.sessions.get(sessionId);
    if (!meta?.workflow) return;
    const i = meta.workflow.stepIndex;
    if (stepIndex !== i) return;
    if (meta.workflow.stepStatuses[i] !== 'waiting-approval') return;
    void this.runStep(sessionId, feedback);
  }

  private advance(sessionId: string) {
    const meta = this.sessions.get(sessionId);
    const wf = meta?.workflow && this.workflows.get(meta.workflow.workflowId);
    if (!meta || !meta.workflow || !wf) return;
    const i = meta.workflow.stepIndex;
    meta.workflow.stepStatuses[i] = 'done';

    if (i + 1 < wf.steps.length) {
      meta.workflow.stepIndex = i + 1;
      void this.runStep(sessionId);
    } else {
      this.sessions.setStatus(sessionId, 'idle');
      this.marker(sessionId, {
        stepIndex: i,
        stepName: wf.steps[i].name,
        event: 'workflow-done',
      });
    }
  }
}
