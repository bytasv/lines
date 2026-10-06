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
import type { ClientMessage, StepContent, StepDef, SyncSigningInfo, WorkflowDef, WorkflowStep } from '@lines/shared';
import { formatTimestamp, isStepRef } from '@lines/shared';
import { ItemTrust, ownSigningKey, syncKeyFingerprint } from './syncSignature.ts';
import type { UserContext } from './userContext.ts';

// ---- mutations ----

/**
 * Save a workflow the user owns. `ownerName` is cosmetic (the owner's display
 * label); `ownerId` is stamped authoritatively inside the engine.
 *
 * Callers that accept an id from outside should run {@link resolveWorkflowRef}
 * first, for the better error message: the engine itself throws
 * `ForeignWorkflowError` for an id belonging to someone else's shared workflow.
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

// ---- trust in synced content ----

/**
 * The owner has seen a synced item's full content and allows it to run on this
 * machine. One entry point for all three kinds, so the WebSocket case stays one
 * line and the two engines cannot disagree about what a confirmation means.
 *
 * It approves that item's reviewed digest and nothing more: not the machine
 * that signed it — nothing here proves that key is one of the user's own, and
 * trusting it would release everything else it signed unseen — and not a later
 * change to the same item. Trusting a machine outright belongs to an explicit
 * step that shows a comparable key fingerprint, which this is not.
 */
export function trustSyncedItem(ctx: UserContext, msg: Extract<ClientMessage, { type: 'trustSyncedItem' }>): void {
  if (typeof msg.ownerId !== 'string' || typeof msg.id !== 'string' || typeof msg.digest !== 'string' || !msg.digest) {
    throw new Error('That trust request is malformed.');
  }
  const version = (): number => {
    if (!Number.isInteger(msg.version)) throw new Error('That trust request names no version.');
    return msg.version!;
  };
  switch (msg.kind) {
    case 'workflow':
      ctx.workflows.trustWorkflow(msg.ownerId, msg.id, msg.digest);
      break;
    case 'step':
      ctx.workflows.trustStep(msg.ownerId, msg.id, version(), msg.digest);
      break;
    case 'recipe':
      ctx.recipes.trustRecipe(msg.ownerId, msg.id, version(), msg.digest);
      break;
    default:
      throw new Error('That trust request is malformed.');
  }
}

/**
 * Refuse a workflow with unverified content before the session it would run in
 * is created — `attach` refuses too, but only once that session exists.
 */
export function assertWorkflowRunnable(ctx: UserContext, workflowId: string): void {
  ctx.workflows.assertRunnable(workflowId);
}

// ---- trusted machines ----

/** Longest base64 a P-256 public key could be (raw, uncompressed: 65 bytes). */
const MAX_KEY_CHARS = 128;

/**
 * This machine's signing-key fingerprint and the machines the account trusts —
 * the owner's `hello` field and the `syncSigning` broadcast. Owner-only: it is
 * what a user compares between their machines, and names the keys they trust.
 */
export function syncSigningInfo(ctx: UserContext, ownKey = ownSigningKey()): SyncSigningInfo {
  return {
    fingerprint: ownKey ? syncKeyFingerprint(ownKey) : null,
    trusted: ItemTrust.forStore(ctx.store.rootDir)
      .signers()
      .map((s) => ({ key: s.key, fingerprint: syncKeyFingerprint(s.key), trustedAt: s.trustedAt })),
  };
}

/**
 * Trust another machine's signing key for this account, after the owner compared
 * its fingerprint with the one that machine shows in its own Settings → Sync.
 * Everything it signed is released, and so is everything it signs from now on.
 *
 * The echoed fingerprint has to be this key's: it is the thing the user looked
 * at, so a key it does not belong to — a stale dialog, a client bug, a crafted
 * message — trusts nothing. Unlike approving an item, this is a statement about
 * a machine, which is why it is its own deliberate action and never a side
 * effect of a review.
 */
export function trustSigner(ctx: UserContext, msg: Extract<ClientMessage, { type: 'trustSigner' }>): void {
  if (typeof msg.key !== 'string' || !msg.key || msg.key.length > MAX_KEY_CHARS || typeof msg.fingerprint !== 'string') {
    throw new Error('That trust request is malformed.');
  }
  let fingerprint: string;
  try {
    fingerprint = syncKeyFingerprint(msg.key);
  } catch {
    throw new Error('That trust request is malformed.');
  }
  if (fingerprint !== msg.fingerprint) {
    throw new Error('That fingerprint does not belong to this key — nothing was trusted.');
  }
  // This machine's own key needs no record: what it signs is trusted already.
  if (msg.key === ownSigningKey()) return;
  ItemTrust.forStore(ctx.store.rootDir).trustSigner(msg.key);
  ctx.workflows.resettleMarks();
  ctx.recipes.resettleMarks();
  ctx.broadcast({ type: 'syncSigning', info: syncSigningInfo(ctx) });
}

/**
 * Stop trusting a machine key. What only it vouched for is held back again at
 * once — the marks kept the record of who signed what — and on every later load
 * and pull. Content the owner approved item by item stays approved: that was a
 * decision about the content, not the machine.
 */
export function untrustSigner(ctx: UserContext, msg: Extract<ClientMessage, { type: 'untrustSigner' }>): void {
  if (typeof msg.key !== 'string' || !msg.key) throw new Error('That request is malformed.');
  if (!ItemTrust.forStore(ctx.store.rootDir).untrustSigner(msg.key)) return;
  ctx.workflows.resettleMarks();
  ctx.recipes.resettleMarks();
  ctx.broadcast({ type: 'syncSigning', info: syncSigningInfo(ctx) });
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
 * The 'foreign' case is what turns a refused write into an answer the model can
 * act on: `WorkflowEngine.save()` throws for such an id, so skipping this check
 * surfaces a raw error instead of naming the workflow and its owner.
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

/**
 * Timestamps in these views are formatted `YYYY-MM-DD HH:MM` strings rather than
 * ms epochs: the only consumers are the MCP tool surface (where a raw epoch is a
 * conversion the model has to do by hand) and this module's tests. The browser
 * reads the numeric fields off the wire types instead — see `stepVersionsView`,
 * which deliberately stays numeric.
 */
export interface WorkflowSummary {
  id: string;
  name: string;
  stepCount: number;
  published: boolean;
  owned: boolean;
  ownerName?: string;
  updatedAt?: string;
  createdAt?: string;
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
    updatedAt: formatTimestamp(w.updatedAt),
    createdAt: formatTimestamp(w.createdAt),
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
  /** The step id's creation, shared by every version of it (see `StepDef.createdAt`). */
  createdAt?: string;
  /** This head version's own mint time. */
  updatedAt?: string;
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
    createdAt: formatTimestamp(s.createdAt),
    updatedAt: formatTimestamp(s.updatedAt),
  };
}

/** A step's full content with its timestamps formatted for a tool result. */
export type StepView = Omit<StepDef, 'createdAt' | 'updatedAt'> & {
  createdAt?: string;
  updatedAt?: string;
};

export function stepView(s: StepDef): StepView {
  return { ...s, createdAt: formatTimestamp(s.createdAt), updatedAt: formatTimestamp(s.updatedAt) };
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
): StepView | undefined {
  const found = readStepDef(ctx, stepId, ownerId, version);
  return found && stepView(found);
}

function readStepDef(
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
 *
 * Returns raw `StepDef`s, timestamps included as ms epochs: this one feeds the
 * browser (`index.ts`'s `stepVersions` reply), whose version popover needs
 * numbers for its relative-time labels. The MCP boundary applies `stepView`
 * itself.
 */
export async function stepVersionsView(
  ctx: UserContext,
  ownerId: string,
  stepId: string,
): Promise<StepDef[]> {
  const remote = await ctx.sync.pullStepVersions(ownerId, stepId);
  // Only the history that was asked for (see addStepVersions).
  if (remote) ctx.workflows.addStepVersions(remote, [{ ownerId, id: stepId }]);
  return ctx.workflows.listStepVersions(ownerId, stepId);
}
