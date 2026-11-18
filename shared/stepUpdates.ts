/**
 * Newer content for the pending steps of a running workflow session.
 *
 * A library attach freezes the workflow onto `WorkflowState.def`, so an edit
 * never renumbers a running session's steps — and, as a side effect, the
 * session never sees the edit either. This module works out, for each still
 * pending step, whether the library now holds newer content for it: a ref step
 * whose step has a newer version (re-pinned in the row, or a newer head), or an
 * inline step whose text changed. The browser uses it to offer the update; the
 * bridge re-derives it before applying one, so a client never supplies content.
 *
 * Imports only types from `./types.ts` (which re-exports this module), so the
 * two never read each other's runtime bindings at load time.
 */
import type { StepContent, StepRef, WorkflowDef, WorkflowState, WorkflowStep } from './types.ts';

/** Every runnable/editable field of a step, in the editor's display order. */
export const STEP_CONTENT_FIELDS = [
  'name',
  'promptTemplate',
  'model',
  'reasoningEffort',
  'permissionMode',
  'autoAdvance',
  'freshStart',
  'outputName',
  'routing',
] as const satisfies readonly (keyof StepContent)[];

/** The latest version of a step known here, with the owner it is stored under. */
export interface StepHead {
  version: number;
  ownerId: string;
  ownerName?: string;
}

export type StepHeadLookup = (ownerId: string, stepId: string) => StepHead | undefined;

const isRef = (s: WorkflowStep): s is StepRef => (s as StepRef).kind === 'ref';

/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

/** One field's value in a form where "absent" and its default compare equal. */
function fieldValue(k: (typeof STEP_CONTENT_FIELDS)[number], v: unknown): string {
  if (k === 'autoAdvance' || k === 'freshStart') return String(v === true);
  if (v === undefined || v === null) return '';
  return typeof v === 'object' ? stableJson(v) : String(v);
}

/** The fields whose values differ between two step contents. */
export function changedStepFields(a: StepContent, b: StepContent): (keyof StepContent)[] {
  return STEP_CONTENT_FIELDS.filter((k) => fieldValue(k, a[k]) !== fieldValue(k, b[k]));
}

/** True when two steps would compare equal on the wire (absent keys dropped, key order ignored). */
export function sameWorkflowStep(a: WorkflowStep, b: WorkflowStep): boolean {
  return stableJson(a) === stableJson(b);
}

/**
 * Newer content for snapshot step `snap`, or undefined when there is none.
 *
 * - A ref takes the higher of the live row's pin for the same step and the
 *   step's head, and only when that beats the snapshot's version. The owner is
 *   taken from wherever the version came from, which heals a drifted `ownerId`
 *   the same way re-pinning in the editor does.
 * - An inline step takes the live one, when that is inline too and its content
 *   differs.
 */
export function stepUpdateCandidate(
  snap: WorkflowStep,
  live: WorkflowStep | undefined,
  head: StepHeadLookup,
): WorkflowStep | undefined {
  if (isRef(snap)) {
    const liveRef = live && isRef(live) && live.stepId === snap.stepId ? live : undefined;
    const h = head(snap.ownerId, snap.stepId);
    const fromHead = h && (!liveRef || h.version >= liveRef.version);
    const version = fromHead ? h.version : liveRef?.version;
    if (version === undefined || version <= snap.version) return undefined;
    const owner = fromHead ? h : liveRef!;
    const next: StepRef = { ...snap, version, ownerId: owner.ownerId };
    if (owner.ownerName !== undefined) next.ownerName = owner.ownerName;
    else delete next.ownerName;
    return next;
  }
  if (!live || isRef(live)) return undefined;
  return changedStepFields(snap, live).length > 0 ? { ...live } : undefined;
}

/**
 * The live row's step that snapshot step `i` corresponds to, if any. A ref, or
 * an inline step with a published `stepId`, matches by that id. Any other
 * inline step has no stable identity (the editor's `_uid` is regenerated on
 * every load), so it matches by position only — and only when the row still has
 * the snapshot's length and the step there is inline too.
 */
export function matchLiveStep(def: WorkflowDef, liveRow: WorkflowDef, i: number): WorkflowStep | undefined {
  const snap = def.steps[i];
  if (!snap) return undefined;
  const id = snap.stepId;
  if (id) return liveRow.steps.find((s) => s.stepId === id);
  if (liveRow.steps.length !== def.steps.length) return undefined;
  const at = liveRow.steps[i];
  return at && !isRef(at) && !at.stepId ? at : undefined;
}

/**
 * Whether step `i` of this run may still take new content: it is pending, and
 * nothing is about to start it (an advance in flight, or a force-advance
 * waiting on the current turn to settle).
 */
export function isStepUpdatable(state: WorkflowState, i: number): boolean {
  if (state.stepStatuses[i] !== 'pending') return false;
  if (state.advancing) return false;
  if (i === state.stepIndex && state.advanceOnComplete) return false;
  return true;
}

/**
 * Per snapshot step, the newer content it could take, or null. Non-null only
 * for updatable (pending) steps. All null for a legacy session without a
 * snapshot — it already follows the live row — and for an unverified one.
 */
export function pendingStepUpdates(
  state: WorkflowState,
  liveRow: WorkflowDef | undefined,
  head: StepHeadLookup,
): (WorkflowStep | null)[] {
  const def = state.def;
  if (!def || def.untrusted) return state.stepStatuses.map(() => null);
  return def.steps.map((snap, i) => {
    if (!isStepUpdatable(state, i)) return null;
    const live = liveRow ? matchLiveStep(def, liveRow, i) : undefined;
    return stepUpdateCandidate(snap, live, head) ?? null;
  });
}
