import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StepContent, StepDef, UntrustedMark, WorkflowDef, WorkflowStep } from '@lines/shared';
import {
  DEFAULT_MODEL,
  isStepRef,
  providerForModel,
  providerSwitchNeedsFreshStart,
  validateRoutingRule,
} from '@lines/shared';
import { useStore } from '../../store';
import { getOwnerId, getOwnerName } from '../../lib/clerk';
import { send } from '../../ws';
import { needsReview } from './UntrustedReview';
import type { WorkflowPreset } from '../../lib/workflowPresets';

/** A pinned reference to a published step (present ⇒ this entry is read-only content). */
export interface DraftRef {
  stepId: string;
  ownerId: string;
  ownerName?: string;
  version: number;
}

/**
 * Editor step: always carries resolved content for display/validation. `ref`
 * marks it as a pinned reference (content is read-only). `publishStepId` is set
 * when an inline step was detached from an owned published step to be edited and
 * re-published under the same id. `copiedFrom` names the pinned step an editable
 * copy replaced — editor-only, never sent, so it is gone after a reload.
 */
export type DraftStep = StepContent & {
  _uid: string;
  ref?: DraftRef;
  publishStepId?: string;
  copiedFrom?: { name: string; version: number; ownerName?: string };
};

export interface DraftWorkflow extends Omit<WorkflowDef, 'steps'> {
  steps: DraftStep[];
  /**
   * A mark this draft picked up from content it copied — a whole held-back
   * workflow (Duplicate), or a held-back pinned step made inline (Make an
   * editable copy). Sent with the next save so the result stays held back until
   * reviewed, then dropped: from there the bridge's own verdict stands.
   * Editor-only, never part of the wire shape or the dirty check.
   */
  heldMark?: UntrustedMark;
}

export interface StepErrors {
  name?: string;
  prompt?: string;
  ref?: string;
  outputName?: string;
  routing?: string;
}

/** The server reads `{outputs.<name>}` with `[\w-]+`, so anything else is unreferenceable. */
export const OUTPUT_NAME_RE = /^[A-Za-z0-9_-]+$/;
export const OUTPUT_NAME_HINT = 'Letters, digits, - and _ only';
export interface ValidationResult {
  name?: string;
  noSteps?: string;
  steps: Record<string, StepErrors>;
  ok: boolean;
}

let uidSeq = 0;
function uid(): string {
  uidSeq += 1;
  return `s${uidSeq}`;
}

const EMPTY_CONTENT: StepContent = {
  name: 'New step',
  promptTemplate: '',
  model: DEFAULT_MODEL,
  permissionMode: 'default',
  autoAdvance: false,
  freshStart: false,
  outputName: '',
};

/**
 * A step's content and nothing else, every field named. The `satisfies` clause
 * is the point: a field added to `StepContent` and not listed here fails the
 * build, instead of being dropped on load, save, publish and re-pin the way
 * `reasoningEffort` was. Optional fields are present as `undefined`, which
 * `JSON.stringify` drops — so the dirty check, `stepsKey` and the wire shape see
 * no key at all for them.
 */
export function contentOf(s: StepContent): StepContent {
  return {
    name: s.name,
    promptTemplate: s.promptTemplate,
    model: s.model,
    permissionMode: s.permissionMode,
    reasoningEffort: s.reasoningEffort,
    routing: s.routing,
    autoAdvance: s.autoAdvance,
    freshStart: s.freshStart,
    outputName: s.outputName ?? '',
  } satisfies Record<keyof StepContent, unknown>;
}

export function useWorkflowDraft(opened: boolean, onClose: () => void) {
  const workflows = useStore((s) => s.workflows);
  const sharedWorkflows = useStore((s) => s.sharedWorkflows);
  const steps = useStore((s) => s.steps);
  const sharedSteps = useStore((s) => s.sharedSteps);
  const pinnedSteps = useStore((s) => s.pinnedSteps);
  const stepVersions = useStore((s) => s.stepVersions);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftWorkflow | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  // The step open in the editor's pane; null = the workflow itself. Every load
  // resets it, so a step only opens on an explicit pick — a loaded workflow
  // opens on its overview, never on whichever step happens to be first.
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The wire JSON of a save that has been sent but not yet seen coming back in a
  // `workflows` broadcast. The draft stays dirty until then, so a write the
  // bridge refused (a foreign id) never renders as "Saved".
  const [savePending, setSavePending] = useState<string | null>(null);
  // Step ids published from this draft whose stored StepDef hasn't arrived yet.
  const pendingPublish = useRef<Set<string>>(new Set());

  // Exact immutable versions available for resolving a ref, keyed `${ownerId}/${id}/${version}`.
  // Fetched histories are folded in so a re-pin to an older version resolves before any round-trip.
  const versionMap = useMemo(() => {
    const m = new Map<string, StepDef>();
    for (const s of [...pinnedSteps, ...steps, ...sharedSteps, ...Object.values(stepVersions).flat()]) {
      m.set(`${s.ownerId}/${s.id}/${s.version}`, s);
    }
    return m;
  }, [pinnedSteps, steps, sharedSteps, stepVersions]);

  // Latest published head per (owner, id) — for update-available detection + diffs.
  const headMap = useMemo(() => {
    const m = new Map<string, StepDef>();
    for (const s of [...steps, ...sharedSteps]) m.set(`${s.ownerId}/${s.id}`, s);
    return m;
  }, [steps, sharedSteps]);

  const resolveRef = useCallback(
    (r: DraftRef): StepContent | undefined => versionMap.get(`${r.ownerId}/${r.stepId}/${r.version}`),
    [versionMap],
  );

  const toDraftStep = useCallback(
    (s: WorkflowStep): DraftStep => {
      if (isStepRef(s)) {
        const ref: DraftRef = { stepId: s.stepId, ownerId: s.ownerId, ownerName: s.ownerName, version: s.version };
        const content = resolveRef(ref) ?? { ...EMPTY_CONTENT, name: `(unavailable step)` };
        return { ...contentOf(content), _uid: uid(), ref };
      }
      return { ...contentOf(s), _uid: uid() };
    },
    [resolveRef],
  );

  const toDraft = useCallback(
    (w: WorkflowDef): DraftWorkflow => ({ ...w, steps: w.steps.map(toDraftStep) }),
    [toDraftStep],
  );

  const loadFrom = useCallback(
    (w: WorkflowDef | null, id: string | null) => {
      const d = w ? toDraft(w) : null;
      setDraft(d);
      setSelectedId(id);
      setBaseline(d ? JSON.stringify(toWire(d)) : null);
      setSelectedStep(null);
      setSubmitAttempted(false);
      // Switching drafts abandons any unconfirmed save: a broadcast for the old
      // one must not set a baseline on the new draft.
      setSavePending(null);
      pendingPublish.current.clear();
    },
    [toDraft],
  );

  // On open, pick the previously-selected workflow or the first owned one. Must
  // not re-run its fallback while the modal stays open with a live draft — a
  // workflows broadcast (e.g. right after saving a new workflow) would otherwise
  // clobber the draft with workflows[0] before id reconciliation runs.
  const prevOpened = useRef(false);
  useEffect(() => {
    const justOpened = opened && !prevOpened.current;
    prevOpened.current = opened;
    if (!opened) return;
    if (!justOpened && draft) return;
    const all = [...workflows, ...sharedWorkflows];
    const source = all.find((w) => w.id === selectedId) ?? workflows[0] ?? null;
    loadFrom(source, source?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, workflows.length, sharedWorkflows.length]);

  // Own list wins, mirroring WorkflowEngine.resolve: the same id can sit in both
  // lists (a stale shared snapshot, or a second identity's published copy), and
  // treating that as foreign hid the Save button on the user's own workflow.
  const readOnly =
    !!draft?.id && !workflows.some((w) => w.id === draft.id) && sharedWorkflows.some((w) => w.id === draft.id);

  const dirty = useMemo(
    () => (draft && baseline ? JSON.stringify(toWire(draft)) !== baseline : false),
    [draft, baseline],
  );

  const validation = useMemo(() => (draft ? validate(draft, resolveRef) : null), [draft, resolveRef]);

  const patchDraft = (patch: Partial<DraftWorkflow>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const updateStep = (u: string, patch: Partial<StepContent>) =>
    setDraft((d) =>
      d ? { ...d, steps: d.steps.map((s) => (s._uid === u && !s.ref ? { ...s, ...patch } : s)) } : d,
    );

  /** Append an inline step: blank, or a copy of `content` (a preset's step). */
  const addStep = (content?: StepContent) => {
    const step: DraftStep = { ...(content ? contentOf(content) : EMPTY_CONTENT), _uid: uid() };
    setDraft((d) => (d ? { ...d, steps: [...d.steps, step] } : d));
    return step._uid;
  };

  /** Insert a pinned reference to a shared/own published step, at its latest version. */
  const addSharedStep = (def: StepDef) => {
    const step: DraftStep = {
      ...contentOf(def),
      _uid: uid(),
      ref: { stepId: def.id, ownerId: def.ownerId, ownerName: def.ownerName, version: def.version },
    };
    setDraft((d) => (d ? { ...d, steps: [...d.steps, step] } : d));
    return step._uid;
  };

  const duplicateStep = (u: string) =>
    setDraft((d) => {
      if (!d) return d;
      const i = d.steps.findIndex((s) => s._uid === u);
      if (i < 0) return d;
      // Duplicating a ref detaches it into an editable inline copy.
      const src = d.steps[i];
      const copy: DraftStep = { ...contentOf(src), _uid: uid(), name: `${src.name} (copy)` };
      const steps = [...d.steps];
      steps.splice(i + 1, 0, copy);
      return { ...d, steps };
    });

  const removeStep = (u: string) => {
    // The pane moves to the step that takes this one's place, else the one
    // before it, else the workflow itself.
    if (selectedStep === u && draft) {
      const i = draft.steps.findIndex((s) => s._uid === u);
      setSelectedStep((draft.steps[i + 1] ?? draft.steps[i - 1])?._uid ?? null);
    }
    setDraft((d) => (d ? { ...d, steps: d.steps.filter((s) => s._uid !== u) } : d));
  };

  const reorder = (from: number, to: number) =>
    setDraft((d) => {
      if (!d || from === to) return d;
      const steps = [...d.steps];
      const [moved] = steps.splice(from, 1);
      steps.splice(to, 0, moved);
      return { ...d, steps };
    });

  // ---- publishing + versioning ----

  const myId = getOwnerId();

  /** Is this ref owned by the current user (so it can be edited/re-published)? */
  const ownsRef = (s: DraftStep) => !!s.ref && steps.some((st) => st.id === s.ref!.stepId);

  /**
   * The published head a ref tracks. The `${ownerId}/${stepId}` key is the exact
   * answer; the fallback covers a ref whose `ownerId` drifted from the one the
   * bridge stamps steps with — without it such a ref reads as owned yet is never
   * offered its new version. Re-pinning writes the head's owner back (below), so
   * the next save heals the ref.
   */
  const headFor = (r: DraftRef): StepDef | undefined =>
    headMap.get(`${r.ownerId}/${r.stepId}`) ?? steps.find((st) => st.id === r.stepId);

  /** Head version available for a ref, if newer than the pinned one. */
  const updateFor = (s: DraftStep): StepDef | undefined => {
    if (!s.ref) return undefined;
    const head = headFor(s.ref);
    return head && head.version > s.ref.version ? head : undefined;
  };

  /** Re-pin a ref to the latest published version. */
  const updateStepToLatest = (u: string) =>
    setDraft((d) => {
      if (!d) return d;
      return {
        ...d,
        steps: d.steps.map((s) => {
          if (s._uid !== u || !s.ref) return s;
          const head = headFor(s.ref);
          if (!head) return s;
          return {
            ...contentOf(head),
            _uid: s._uid,
            // ownerId too, not just the version: a re-pin is where a drifted ref
            // gets its owner corrected to the one the head is actually stored under.
            ref: { ...s.ref, ownerId: head.ownerId, ownerName: head.ownerName, version: head.version },
          };
        }),
      };
    });

  /** Re-pin every ref that has a newer published version. */
  const updateAllToLatest = () =>
    setDraft((d) => {
      if (!d) return d;
      return {
        ...d,
        steps: d.steps.map((s) => {
          if (!s.ref) return s;
          const head = headFor(s.ref);
          if (!head || head.version <= s.ref.version) return s;
          return {
            ...contentOf(head),
            _uid: s._uid,
            ref: { ...s.ref, ownerId: head.ownerId, ownerName: head.ownerName, version: head.version },
          };
        }),
      };
    });

  /** Ask the bridge for a ref's full version history; the reply lands in the store slice. */
  const requestStepVersions = (s: DraftStep) => {
    if (!s.ref) return;
    send({ type: 'stepVersions', ownerId: s.ref.ownerId, stepId: s.ref.stepId });
  };

  /**
   * Versions available for a ref, newest first. Unions the fetched history with any versions already
   * in `versionMap` (guarantees the pinned version always appears — in-flight fetch, storage offline,
   * or foreign publish-filter). `undefined` = nothing known yet → loading state.
   */
  const versionsFor = (s: DraftStep): StepDef[] | undefined => {
    if (!s.ref) return undefined;
    const fetched = stepVersions[`${s.ref.ownerId}/${s.ref.stepId}`];
    const local = [...versionMap.values()].filter(
      (d) => d.ownerId === s.ref!.ownerId && d.id === s.ref!.stepId,
    );
    if (!fetched && local.length === 0) return undefined;
    const byVersion = new Map<number, StepDef>();
    for (const d of [...(fetched ?? []), ...local]) if (!byVersion.has(d.version)) byVersion.set(d.version, d);
    return [...byVersion.values()].sort((a, b) => b.version - a.version);
  };

  /** Re-pin a ref to a specific (possibly older) version. Draft-only until save; dirty guard covers cancel. */
  const pinStepToVersion = (u: string, def: StepDef) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            steps: d.steps.map((s) =>
              s._uid === u && s.ref
                ? {
                    ...contentOf(def),
                    _uid: s._uid,
                    ref: {
                      ...s.ref,
                      ownerId: def.ownerId,
                      ownerName: def.ownerName ?? s.ref.ownerName,
                      version: def.version,
                    },
                  }
                : s,
            ),
          }
        : d,
    );

  /** Save an inline step to the library (private by default); convert it to an owned ref. */
  const publishStep = (u: string) => {
    const step = draft?.steps.find((s) => s._uid === u);
    if (!step || step.ref) return;
    const stepId = step.publishStepId ?? crypto.randomUUID();
    const prevHead = steps.find((s) => s.id === stepId);
    const version = prevHead ? prevHead.version + 1 : 1;
    send({ type: 'saveStep', step: contentOf(step), stepId, published: prevHead?.published ?? false, ownerName: getOwnerName() ?? undefined });
    // Optimistic ref so the card flips to "pinned" immediately; the owner and
    // version the bridge actually stored are adopted from the next `steps`
    // broadcast (see below) rather than guessed from here.
    pendingPublish.current.add(stepId);
    setDraft((d) =>
      d
        ? {
            ...d,
            steps: d.steps.map((s) =>
              s._uid === u
                ? { ...contentOf(s), _uid: u, ref: { stepId, ownerId: myId ?? '', ownerName: getOwnerName() ?? undefined, version } }
                : s,
            ),
          }
        : d,
    );
  };

  // Adopt the stored StepDef for a just-published step: its `ownerId` is the
  // bridge's, which is the only one a later resolve/update lookup will match.
  useEffect(() => {
    if (pendingPublish.current.size === 0) return;
    const landed = [...pendingPublish.current]
      .map((id) => steps.find((s) => s.id === id))
      .filter((s): s is StepDef => !!s);
    if (landed.length === 0) return;
    for (const head of landed) pendingPublish.current.delete(head.id);
    setDraft((d) =>
      d
        ? {
            ...d,
            steps: d.steps.map((s) => {
              const head = s.ref && landed.find((h) => h.id === s.ref!.stepId);
              return head && s.ref
                ? {
                    ...s,
                    ref: {
                      ...s.ref,
                      ownerId: head.ownerId,
                      ownerName: head.ownerName ?? s.ref.ownerName,
                      version: head.version,
                    },
                  }
                : s;
            }),
          }
        : d,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps]);

  /** Detach an owned ref into an editable inline step; re-publishing bumps its version. */
  const editStep = (u: string) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            steps: d.steps.map((s) =>
              s._uid === u && s.ref ? { ...contentOf(s), _uid: u, publishStepId: s.ref.stepId } : s,
            ),
          }
        : d,
    );

  /**
   * Replace a ref, in place, with an inline step carrying the same content — no
   * longer tied to the library, so neither an update nor a republish reaches it.
   * In place rather than added below: a copy beside its original ran both.
   */
  const detachStep = (u: string) =>
    setDraft((d) => {
      if (!d) return d;
      // A pinned version held back here keeps holding the workflow back once it
      // is inline — otherwise "Make an editable copy" would run it unreviewed.
      const pinned = d.steps.find((s) => s._uid === u)?.ref;
      const pinnedMark = pinned && versionMap.get(`${pinned.ownerId}/${pinned.stepId}/${pinned.version}`)?.untrusted;
      const mark = needsReview(pinnedMark) ? pinnedMark : undefined;
      return {
        ...d,
        ...(mark && !d.heldMark ? { heldMark: mark } : {}),
        steps: d.steps.map((s) =>
          s._uid === u && s.ref
            ? {
                ...contentOf(s),
                _uid: u,
                copiedFrom: { name: s.name, version: s.ref.version, ownerName: s.ref.ownerName },
              }
            : s,
        ),
      };
    });

  /** Open a step in the pane, or the workflow itself with `null`. */
  const selectStep = (u: string | null) => setSelectedStep(u);

  // ---- guarded navigation ----
  const doNew = (preset: WorkflowPreset | null) => {
    const wf: WorkflowDef = {
      id: '',
      name: preset ? preset.name : 'New workflow',
      steps: preset ? preset.steps.map((s) => ({ ...s })) : [{ ...EMPTY_CONTENT }],
    };
    loadFrom(wf, null);
  };

  const select = (w: WorkflowDef) => {
    if (dirty) setPendingAction({ kind: 'select', target: w });
    else loadFrom(w, w.id);
  };

  const newFromPreset = (preset: WorkflowPreset | null) => {
    if (dirty) setPendingAction({ kind: 'new', preset });
    else doNew(preset);
  };

  const requestClose = () => {
    if (dirty) setPendingAction({ kind: 'close' });
    else onClose();
  };

  const confirmDiscard = () => {
    const action = pendingAction;
    setPendingAction(null);
    if (!action) return;
    if (action.kind === 'close') onClose();
    else if (action.kind === 'select') loadFrom(action.target, action.target.id);
    else doNew(action.preset);
  };

  const cancelDiscard = () => setPendingAction(null);

  const save = (): boolean => {
    if (!draft || readOnly) return false;
    setSubmitAttempted(true);
    const v = validate(draft, resolveRef);
    if (!v.ok) return false;
    const wire = toWire(draft);
    // Content copied from something held back says so (see `heldMark`), outside
    // `wire`, which is also the key the save is matched back on. Sent once: a
    // later save after a review must not re-mark what the review cleared.
    const sent = draft.heldMark ? { ...wire, untrusted: draft.heldMark } : wire;
    send({ type: 'saveWorkflow', workflow: sent, ownerName: getOwnerName() ?? undefined });
    if (draft.heldMark) setDraft((d) => (d ? { ...d, heldMark: undefined } : d));
    // Baseline is NOT advanced here: the bridge can refuse the write (and says so
    // via `actionError`), and an optimistic baseline reported that as saved.
    setSavePending(JSON.stringify(wire));
    setSubmitAttempted(false);
    return true;
  };

  // A save is confirmed by the broadcast that carries it back, matched on
  // content — the bridge restamps `updatedAt`/`ownerId`, so the blob is never
  // byte-identical.
  useEffect(() => {
    if (!savePending || !draft?.id) return;
    const attempt = JSON.parse(savePending) as WorkflowDef;
    const match = workflows.find((w) => w.id === draft.id);
    if (!match || match.name !== attempt.name) return;
    if (stepsKey(match.steps) !== stepsKey(attempt.steps)) return;
    setBaseline(savePending);
    setSavePending(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflows, savePending, draft?.id]);

  // Reconcile a just-saved NEW workflow (id:'') with the server-assigned id.
  useEffect(() => {
    if (!draft || selectedId !== null || draft.id || savePending === null) return;
    if (JSON.stringify(toWire(draft)) !== savePending) return;
    const draftSteps = stepsKey(toWire(draft).steps);
    const match = workflows
      .filter((w) => w.name === draft.name && stepsKey(w.steps) === draftSteps)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    if (match) {
      setSelectedId(match.id);
      // createdAt too: it is stamped by the bridge on the first save, so without
      // this the header stays blank until the modal is reopened.
      setDraft((d) =>
        d ? { ...d, id: match.id, updatedAt: match.updatedAt, createdAt: match.createdAt } : d,
      );
      setBaseline(
        JSON.stringify(
          toWire({ ...draft, id: match.id, updatedAt: match.updatedAt, createdAt: match.createdAt }),
        ),
      );
      setSavePending(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflows]);

  const duplicate = () => {
    if (!draft) return;
    // A copy of a workflow this machine has not verified is not verified either:
    // the bridge keeps a copy's mark, so copying cannot be how it gets to run.
    // Read off the live row rather than the draft, which may predate a review.
    const live = [...workflows, ...sharedWorkflows].find((w) => w.id === draft.id);
    // A trusted machine's content is the user's own: a copy of it is too.
    const mark = needsReview(live?.untrusted) ? live?.untrusted : draft.heldMark;
    // `toDraft` spreads the def it loads, so the mark rides into the new draft.
    const copy: WorkflowDef & Pick<DraftWorkflow, 'heldMark'> = {
      ...toWire(draft),
      id: '',
      name: `${draft.name} (copy)`,
      published: false,
      ...(mark ? { heldMark: mark } : {}),
    };
    loadFrom(copy, null);
  };

  const requestDelete = () => setConfirmDelete(true);
  const cancelDelete = () => setConfirmDelete(false);
  const deleteSelected = () => {
    setConfirmDelete(false);
    if (!selectedId) return;
    send({ type: 'deleteWorkflow', workflowId: selectedId });
    loadFrom(workflows.find((w) => w.id !== selectedId) ?? null, null);
  };

  return {
    workflows,
    sharedWorkflows,
    steps,
    sharedSteps,
    selectedId,
    draft,
    readOnly,
    dirty,
    validation,
    submitAttempted,
    selectedStep,
    pendingAction,
    confirmDelete,
    // step helpers
    ownsRef,
    updateFor,
    resolveRef,
    headMap,
    // actions
    patchDraft,
    updateStep,
    addStep,
    addSharedStep,
    duplicateStep,
    removeStep,
    reorder,
    publishStep,
    editStep,
    detachStep,
    updateStepToLatest,
    updateAllToLatest,
    requestStepVersions,
    versionsFor,
    pinStepToVersion,
    selectStep,
    select,
    newFromPreset,
    requestClose,
    confirmDiscard,
    cancelDiscard,
    save,
    duplicate,
    requestDelete,
    cancelDelete,
    deleteSelected,
  };
}

type PendingAction =
  | { kind: 'close' }
  | { kind: 'select'; target: WorkflowDef }
  | { kind: 'new'; preset: WorkflowPreset | null }
  | null;

/**
 * Content key for matching a saved workflow against the attempt that produced
 * it. Ref owner stamps are excluded: the bridge is the authority on `ownerId`
 * (it heals a drifted one on save), so a corrected owner is a confirmation of
 * this save, not a different workflow.
 */
function stepsKey(steps: WorkflowStep[]): string {
  return JSON.stringify(
    steps.map((s) => (isStepRef(s) ? { kind: s.kind, stepId: s.stepId, version: s.version } : s)),
  );
}

/**
 * Does the step at `i` run on a different provider from the one before it?
 *
 * Only meaningful from step 1 on: step 0's predecessor is the session it is
 * attached to, which the editor cannot know. The runner checks that case
 * against the session's actual conversation.
 *
 * A `ref` step's model lives in the shared definition, not the draft, so a
 * crossing into or out of one is left to the runner rather than guessed at here.
 */
function crossesProviderAt(steps: DraftStep[], i: number): boolean {
  const previous = steps[i - 1];
  const step = steps[i];
  if (!previous || !step || previous.ref || step.ref) return false;
  return providerSwitchNeedsFreshStart(
    providerForModel(previous.model),
    providerForModel(step.model),
  );
}

/** Serialize a draft to the wire shape: refs → StepRef, inline → StepContent. */
function toWire(d: DraftWorkflow): WorkflowDef {
  const steps: WorkflowStep[] = d.steps.map((s, i) =>
    s.ref
      ? { kind: 'ref', stepId: s.ref.stepId, ownerId: s.ref.ownerId, ownerName: s.ref.ownerName, version: s.ref.version }
      : {
          ...contentOf(s),
          // Forced on for a step that changes provider, matching what the
          // connector shows. The editor locks it, but a workflow saved before
          // this rule existed can still hold `false` here, and saving it back
          // unchanged would store a step the runner refuses to start.
          freshStart: s.freshStart || crossesProviderAt(d.steps, i),
        },
  );
  // `untrusted` is the bridge's verdict on the stored row, never echoed back —
  // sending a stale one after a review would hold the workflow back again — and
  // `heldMark` is editor-only (`save` sends it on purpose, once).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { steps: _drop, untrusted: _verdict, heldMark: _copied, ...rest } = d;
  return { ...rest, steps };
}

export function validate(
  d: DraftWorkflow,
  resolveRef: (r: DraftRef) => StepContent | undefined,
): ValidationResult {
  const steps: Record<string, StepErrors> = {};
  // Two steps publishing the same name silently overwrite each other at runtime
  // (last writer wins), so count them up front and flag both.
  const counts = new Map<string, number>();
  for (const s of d.steps) {
    const out = (s.ref ? resolveRef(s.ref)?.outputName : s.outputName)?.trim();
    if (out) counts.set(out, (counts.get(out) ?? 0) + 1);
  }
  // Names published by the steps *before* the one being checked — a template can
  // only pull an output that already exists by the time it runs.
  const published = new Set<string>();
  for (const s of d.steps) {
    const e: StepErrors = {};
    const content = s.ref ? resolveRef(s.ref) : s;
    if (s.ref) {
      if (!content) e.ref = 'Pinned step unavailable';
    } else {
      if (!s.name.trim()) e.name = 'Required';
      if (!s.promptTemplate.trim()) e.prompt = 'Prompt is required';
    }
    const unknown = [...(content?.promptTemplate ?? '').matchAll(/\{outputs\.([\w-]+)\}/g)]
      .map((m) => m[1])
      .filter((n, idx, all) => !published.has(n) && all.indexOf(n) === idx);
    // The step would park at runtime rather than run — say so here instead.
    if (!e.prompt && unknown.length) {
      e.prompt = `No earlier step publishes ${unknown.map((n) => `{outputs.${n}}`).join(', ')}`;
    }
    const out = (content?.outputName ?? '').trim();
    if (out && !OUTPUT_NAME_RE.test(out)) e.outputName = OUTPUT_NAME_HINT;
    else if (out && (counts.get(out) ?? 0) > 1) e.outputName = 'Another step already publishes this name';
    if (out) published.add(out);
    if (!s.ref && s.routing) {
      const issues = validateRoutingRule(s.routing, providerForModel(s.model));
      if (issues.length) e.routing = issues[0];
    }
    if (e.name || e.prompt || e.ref || e.outputName || e.routing) steps[s._uid] = e;
  }
  const name = d.name.trim() ? undefined : 'Workflow name is required';
  const noSteps = d.steps.length === 0 ? 'Add at least one step' : undefined;
  const ok = !name && !noSteps && Object.keys(steps).length === 0;
  return { name, noSteps, steps, ok };
}
