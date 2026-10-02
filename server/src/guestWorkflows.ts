import type {
  InlineStep,
  PermissionMode,
  SessionMeta,
  SocketAccess,
  StepDef,
  WorkflowDef,
} from '@lines/shared';
import { formatWorkflowIssues, isStepRef, validateWorkflow } from '@lines/shared';
import type { UserContext } from './userContext.ts';

/** The workflow fields of a guest's `hello`. */
export interface GuestLibrary {
  workflows: WorkflowDef[];
  sharedWorkflows: WorkflowDef[];
  steps: StepDef[];
  sharedSteps: StepDef[];
  pinnedSteps: StepDef[];
}

const EMPTY_LIBRARY: GuestLibrary = {
  workflows: [],
  sharedWorkflows: [],
  steps: [],
  sharedSteps: [],
  pinnedSteps: [],
};

/**
 * What of the host's workflow library a guest's `hello` carries.
 *
 * A machine guest who may create sessions sees the whole library — the same
 * fields the owner gets — so they can start a session with one of the host's
 * workflows. Read only: authoring stays owner-only in MESSAGE_AUTHZ.
 *
 * Every other guest gets only the workflows attached to sessions they can see,
 * so the stepper renders; the rest of the library is none of their business.
 */
export function guestLibrary(ctx: UserContext, access: SocketAccess, sessions: SessionMeta[]): GuestLibrary {
  if (access.scope === 'owner') return EMPTY_LIBRARY;
  if (access.scope === 'machine' && access.caps.createSessions) {
    return {
      workflows: ctx.workflows.list(),
      sharedWorkflows: ctx.workflows.listShared(),
      steps: ctx.workflows.listSteps(),
      sharedSteps: ctx.workflows.listSharedSteps(),
      pinnedSteps: ctx.workflows.listPinnedSteps(),
    };
  }
  // An inline snapshot carries its own steps; only library-backed runs need the row.
  const ids = new Set(sessions.filter((s) => s.workflow && !s.workflow.def).map((s) => s.workflow!.workflowId));
  if (!ids.size) return EMPTY_LIBRARY;
  const workflows = ctx.workflows.list().filter((w) => ids.has(w.id));
  const sharedWorkflows = ctx.workflows.listShared().filter((w) => ids.has(w.id));
  // Just the step versions those workflows pin, so their refs resolve.
  const refs = [...workflows, ...sharedWorkflows].flatMap((w) => w.steps.filter(isStepRef));
  const pinned = (s: StepDef) =>
    refs.some((r) => r.ownerId === s.ownerId && r.stepId === s.id && r.version === s.version);
  return {
    workflows,
    sharedWorkflows,
    steps: [],
    sharedSteps: ctx.workflows.listSharedSteps().filter(pinned),
    pinnedSteps: ctx.workflows.listPinnedSteps().filter(pinned),
  };
}

/**
 * The permission mode a session (or a step) may actually take for this actor.
 * Without `setPermissionMode` a guest cannot pick one, at creation either — a
 * client-sent `bypassPermissions` would otherwise walk straight around the cap —
 * so it is clamped to the host's own new-session default.
 */
export function clampPermissionMode(ctx: UserContext, access: SocketAccess, mode: PermissionMode): PermissionMode {
  if (access.caps.setPermissionMode) return mode;
  return ctx.store.loadSettings()?.newSessionDefaults?.permissionMode ?? 'default';
}

/**
 * Check a guest's own workflow before it runs on this machine, and clamp its
 * steps' permission modes the way the session's is. It must be self-contained —
 * a `ref` would resolve against this machine's step library, not the guest's —
 * and pass the same validation the editor applies, Claude-only steps included.
 */
export function prepareInlineWorkflow(
  ctx: UserContext,
  access: SocketAccess,
  def: WorkflowDef,
): { ok: true; def: WorkflowDef } | { ok: false; reason: string } {
  if (!access.caps.manageWorkflow) {
    return { ok: false, reason: 'Only a collaborator can run a workflow here.' };
  }
  if (!def || typeof def.id !== 'string' || !def.id || !Array.isArray(def.steps)) {
    return { ok: false, reason: 'That workflow is malformed.' };
  }
  if (def.steps.some(isStepRef)) {
    return { ok: false, reason: 'That workflow has a shared step that could not be inlined.' };
  }
  const issues = validateWorkflow(
    def.name,
    (def.steps as InlineStep[]).map((step) => ({ isRef: false, content: step })),
    { strictModel: true },
  );
  if (issues.length) return { ok: false, reason: formatWorkflowIssues(issues) };
  return {
    ok: true,
    def: {
      ...def,
      steps: (def.steps as InlineStep[]).map((step) => ({
        ...step,
        permissionMode: clampPermissionMode(ctx, access, step.permissionMode),
      })),
    },
  };
}
