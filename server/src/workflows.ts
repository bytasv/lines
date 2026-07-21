import { randomUUID } from 'node:crypto';
import type { ServerMessage, WorkflowDef, WorkflowMarkerData, WorkflowState } from '@claude-ui/shared';
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

    if (step.autoAdvance) {
      this.advance(sessionId);
    } else {
      meta.workflow.stepStatuses[i] = 'waiting-approval';
      this.sessions.setStatus(sessionId, 'waiting-approval');
      this.marker(sessionId, { stepIndex: i, stepName: step.name, event: 'waiting-approval' });
    }
  }

  approve(sessionId: string) {
    const meta = this.sessions.get(sessionId);
    if (!meta?.workflow) return;
    const i = meta.workflow.stepIndex;
    if (meta.workflow.stepStatuses[i] !== 'waiting-approval') return;
    const wf = this.workflows.get(meta.workflow.workflowId);
    this.marker(sessionId, {
      stepIndex: i,
      stepName: wf?.steps[i]?.name ?? '',
      event: 'approved',
    });
    this.advance(sessionId);
  }

  retry(sessionId: string, feedback: string) {
    const meta = this.sessions.get(sessionId);
    if (!meta?.workflow) return;
    const i = meta.workflow.stepIndex;
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
