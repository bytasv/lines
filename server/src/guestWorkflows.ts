import path from 'node:path';
import type {
  InlineStep,
  PermissionMode,
  SessionMeta,
  SocketAccess,
  StepDef,
  WorkflowDef,
} from '@lines/shared';
import { formatWorkflowIssues, isStepRef, normalizeRootPath, projectRoots, validateWorkflow } from '@lines/shared';
import { isRealInside } from './autoGuard.ts';
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
 * The extras a permission answer may carry for this actor.
 *
 * Approving or denying the card is what `approvePermissions` grants. What an
 * answer can *also* write is not an answer at all but a setting, and it is the
 * owner's: `alwaysAllow` widens this machine's allowlist for every future
 * session, and `allowAsRead` records a plan-mode read rule the same way. A
 * guest clicking either gets the one-off approval and nothing more.
 */
export function permissionAnswerFor(
  access: SocketAccess,
  msg: { alwaysAllow?: boolean; allowAsRead?: boolean },
): { alwaysAllow: boolean; allowAsRead: boolean } {
  const owner = access.scope === 'owner';
  return {
    alwaysAllow: owner && msg.alwaysAllow === true,
    allowAsRead: owner && msg.allowAsRead === true,
  };
}

/**
 * May a guest start a session in `cwd`?
 *
 * A machine share lends the host's open projects — that is what the guest is
 * shown, and where their sessions belong. The cwd arrives from the guest's
 * browser, though, and without this check `/` or the host's home directory
 * would do just as well, putting every file on the machine one prompt away.
 * Compared after resolving symlinks on both sides, so a link inside a project
 * cannot carry the session out of it. The owner may open anything.
 */
export function guestCwdAllowed(ctx: UserContext, access: SocketAccess, cwd: string): boolean {
  if (access.scope === 'owner') return true;
  const dir = normalizeRootPath(cwd);
  if (!dir || !path.isAbsolute(dir)) return false;
  // The same containment the guard and the file routes use: inside as written
  // and once links are followed, with a path that climbs (`..`) never counting.
  return isRealInside(ctx.store.loadProjects().flatMap((p) => projectRoots(p)), dir);
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
  // A backstop, not the gate: the guest's own machine is the one that can tell
  // whether this content was verified, and the browser refuses to send it when it
  // was not. A def or step still carrying a mark is one it sent anyway — an older
  // client, say — and nothing about this machine can vouch for it instead.
  if (def.untrusted || (def.steps as (InlineStep & { untrusted?: unknown })[]).some((step) => step.untrusted)) {
    return {
      ok: false,
      reason: 'That workflow has content its owner’s machine has not verified. Review it there first.',
    };
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
