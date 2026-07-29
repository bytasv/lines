/**
 * The workflow/step command layer: every mutation and every read that more than
 * one surface needs.
 *
 * Two callers today — the browser's WebSocket messages and the MCP tool surface
 * a session talks to. They must not drift, and the parts that are easy to get
 * wrong (which side effects a delete owes the storage sync, whether an id is
 * even this user's to write) live here once instead of at each entry point.
 *
 * `UserContext` is imported type-only: userContext.ts builds the engine and the
 * sync client this module drives, so a value import would be a cycle.
 */
import type { StepContent, StepDef, WorkflowDef, WorkflowStep } from '@lines/shared';
import { isStepRef } from '@lines/shared';
import type { UserContext } from './userContext.ts';

// ---- mutations ----

/**
 * Save a workflow the user owns. `ownerName` is cosmetic (the owner's display
 * label); `ownerId` is stamped authoritatively inside the engine.
 *
 * Callers that accept an id from outside must run {@link resolveWorkflowRef}
 * first — the engine silently returns the input unchanged for an id belonging to
 * someone else's shared workflow.
 */
export function saveWorkflow(
  ctx: UserContext,
  { workflow, ownerName }: { workflow: WorkflowDef; ownerName?: string },
): WorkflowDef {
  if (ownerName !== undefined) workflow.ownerName = ownerName;
  return ctx.workflows.save(workflow);
}

export function deleteWorkflow(ctx: UserContext, workflowId: string): void {
  ctx.workflows.delete(workflowId);
  // The 'workflows' broadcast only upserts what's left; remove the row too.
  ctx.sync.deleteWorkflow(workflowId);
}

export function saveStep(
  ctx: UserContext,
  {
    step,
    stepId,
    published,
    ownerName,
  }: { step: StepContent; stepId?: string; published: boolean; ownerName?: string },
): StepDef {
  return ctx.workflows.saveStep(step, stepId, published, ownerName);
}

export function deleteStep(ctx: UserContext, stepId: string): void {
  ctx.workflows.deleteStep(stepId);
  ctx.sync.deleteStep(stepId);
}

// ---- resolution / policy ----

export type WorkflowScope = 'owned' | 'shared' | 'all';

export interface WorkflowCandidate {
  id: string;
  name: string;
  /** False for another user's published workflow — read-only here. */
  owned: boolean;
}

export type WorkflowRefResult =
  | { ok: true; workflow: WorkflowDef }
  | { ok: false; reason: 'not-found' | 'ambiguous' | 'foreign'; candidates: WorkflowCandidate[] };

/**
 * Resolve a caller-supplied workflow reference — an id, or a name — to a
 * workflow this user may write.
 *
 * Name matching exists so "add a review step to the MVP flow" is one hop rather
 * than a disambiguation dialog, and is restricted to owned workflows: a foreign
 * name match would otherwise resolve to something the caller cannot write.
 *
 * The 'foreign' case is the one that matters. `WorkflowEngine.save()` returns its
 * input unchanged for an id that belongs to a shared workflow — no error, no
 * write — so a caller that skips this check reports a successful save of nothing.
 */
export function resolveWorkflowRef(ctx: UserContext, ref: string): WorkflowRefResult {
  const needle = ref.trim();
  const owned = ctx.workflows.list();
  if (!needle) return { ok: false, reason: 'not-found', candidates: candidatesOf(ctx) };

  const byId = owned.find((w) => w.id === needle);
  if (byId) return { ok: true, workflow: byId };

  // Owned names are matched before shared ones: a user who names a workflow the
  // same as somebody's published one must still be able to write their own.
  const byName = owned.filter((w) => w.name.trim().toLowerCase() === needle.toLowerCase());
  if (byName.length === 1) return { ok: true, workflow: byName[0]! };
  if (byName.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: byName.map((w) => ({ id: w.id, name: w.name, owned: true })),
    };
  }

  const shared = ctx.workflows.listShared();
  const foreign =
    shared.find((w) => w.id === needle) ??
    shared.find((w) => w.name.trim().toLowerCase() === needle.toLowerCase());
  if (foreign) {
    return {
      ok: false,
      reason: 'foreign',
      candidates: [{ id: foreign.id, name: foreign.name, owned: false }],
    };
  }
  return { ok: false, reason: 'not-found', candidates: candidatesOf(ctx) };
}

function candidatesOf(ctx: UserContext): WorkflowCandidate[] {
  return ctx.workflows.list().map((w) => ({ id: w.id, name: w.name, owned: true }));
}

/**
 * The owner's display label, recovered from what this user has already saved.
 * The browser sends it explicitly (it has the Clerk profile); a session-driven
 * write has no such source, and stamping nothing would blank the label that
 * other users see next to a published workflow.
 */
export function ownerDisplayName(ctx: UserContext): string | undefined {
  for (const step of ctx.workflows.listSteps()) {
    if (step.ownerId === ctx.userId && step.ownerName) return step.ownerName;
  }
  for (const workflow of ctx.workflows.list()) {
    if (workflow.ownerId === ctx.userId && workflow.ownerName) return workflow.ownerName;
  }
  return undefined;
}

/** Sessions currently running this workflow — a delete or an edit under them is disruptive. */
export function workflowInUse(ctx: UserContext, workflowId: string): { sessionId: string; name: string }[] {
  return ctx.sessions
    .list()
    .filter((s) => s.workflow?.workflowId === workflowId)
    .map((s) => ({ sessionId: s.id, name: s.name }));
}

/** One immutable step version, if this bridge has it cached. */
export function lookupStepVersion(
  ctx: UserContext,
  ownerId: string,
  stepId: string,
  version: number,
): StepDef | undefined {
  return ctx.workflows.listStepVersions(ownerId, stepId).find((s) => s.version === version);
}

// ---- reads ----

/** Cap on any list a tool returns, so an answer can't blow out the model's context. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

function clampLimit(limit?: number): number {
  if (!limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

export interface WorkflowSummary {
  id: string;
  name: string;
  stepCount: number;
  published: boolean;
  owned: boolean;
  ownerName?: string;
  updatedAt?: number;
}

export function listWorkflowsView(
  ctx: UserContext,
  scope: WorkflowScope = 'owned',
  limit?: number,
): WorkflowSummary[] {
  const rows: WorkflowSummary[] = [];
  if (scope !== 'shared') {
    for (const w of ctx.workflows.list()) rows.push(summary(w, true));
  }
  if (scope !== 'owned') {
    for (const w of ctx.workflows.listShared()) rows.push(summary(w, false));
  }
  return rows.slice(0, clampLimit(limit));
}

function summary(w: WorkflowDef, owned: boolean): WorkflowSummary {
  return {
    id: w.id,
    name: w.name,
    stepCount: w.steps.length,
    published: w.published === true,
    owned,
    ownerName: w.ownerName,
    updatedAt: w.updatedAt,
  };
}

export interface WorkflowStepView {
  index: number;
  name: string;
  promptTemplate: string;
  model: string;
  permissionMode: string;
  autoAdvance: boolean;
  freshStart: boolean;
  outputName?: string;
  /** Set when the step is a pinned reference to another author's published version. */
  pinned?: { stepId: string; ownerId: string; version: number };
}

export interface WorkflowView extends WorkflowSummary {
  steps: WorkflowStepView[];
  /** Pinned refs whose version this bridge could not resolve — the workflow can't run as-is. */
  unresolvedSteps: { index: number; stepId: string; ownerId: string; version: number }[];
}

/**
 * The full workflow, with pinned refs resolved to the content that will actually
 * run. Unresolvable pins are reported rather than rendered as empty steps: they
 * are the difference between a workflow that runs and one that parks at that step.
 */
export function readWorkflowView(ctx: UserContext, workflow: WorkflowDef, owned = true): WorkflowView {
  const steps: WorkflowStepView[] = [];
  const unresolvedSteps: WorkflowView['unresolvedSteps'] = [];
  workflow.steps.forEach((step, index) => {
    const content = isStepRef(step)
      ? lookupStepVersion(ctx, step.ownerId, step.stepId, step.version)
      : step;
    if (!content) {
      const ref = step as Extract<WorkflowStep, { kind: 'ref' }>;
      unresolvedSteps.push({ index, stepId: ref.stepId, ownerId: ref.ownerId, version: ref.version });
      return;
    }
    steps.push({
      index,
      name: content.name,
      promptTemplate: content.promptTemplate,
      model: content.model,
      permissionMode: content.permissionMode,
      autoAdvance: content.autoAdvance,
      freshStart: content.freshStart,
      ...(content.outputName ? { outputName: content.outputName } : {}),
      ...(isStepRef(step)
        ? { pinned: { stepId: step.stepId, ownerId: step.ownerId, version: step.version } }
        : {}),
    });
  });
  return { ...summary(workflow, owned), steps, unresolvedSteps };
}

export interface StepSummary {
  id: string;
  ownerId: string;
  ownerName?: string;
  name: string;
  version: number;
  published: boolean;
  owned: boolean;
  outputName?: string;
}

export function listStepsView(
  ctx: UserContext,
  scope: WorkflowScope = 'owned',
  limit?: number,
): StepSummary[] {
  const rows: StepSummary[] = [];
  if (scope !== 'shared') {
    for (const s of ctx.workflows.listSteps()) rows.push(stepSummary(s, true));
  }
  if (scope !== 'owned') {
    for (const s of ctx.workflows.listSharedSteps()) rows.push(stepSummary(s, false));
  }
  return rows.slice(0, clampLimit(limit));
}

function stepSummary(s: StepDef, owned: boolean): StepSummary {
  return {
    id: s.id,
    ownerId: s.ownerId,
    ownerName: s.ownerName,
    name: s.name,
    version: s.version,
    published: s.published,
    owned,
    ...(s.outputName ? { outputName: s.outputName } : {}),
  };
}

/**
 * One step's full content. Defaults to this user's own head; `ownerId` reads
 * another author's library entry and `version` an older pinned version.
 */
export function readStepView(
  ctx: UserContext,
  stepId: string,
  ownerId?: string,
  version?: number,
): StepDef | undefined {
  const owner = ownerId ?? ctx.userId;
  if (version !== undefined) return lookupStepVersion(ctx, owner, stepId, version);
  if (owner === ctx.userId) {
    const own = ctx.workflows.listSteps().find((s) => s.id === stepId);
    if (own) return own;
  }
  return ctx.workflows.listSharedSteps().find((s) => s.id === stepId && s.ownerId === owner);
}

/**
 * A step's version history, newest first. Pulls remote history first and adopts
 * it, so re-pins resolve — the local cache only holds versions this install has
 * seen. Offline, the cached view is the answer.
 */
export async function stepVersionsView(
  ctx: UserContext,
  ownerId: string,
  stepId: string,
): Promise<StepDef[]> {
  const remote = await ctx.sync.pullStepVersions(ownerId, stepId);
  if (remote) ctx.workflows.addStepVersions(remote);
  return ctx.workflows.listStepVersions(ownerId, stepId);
}
