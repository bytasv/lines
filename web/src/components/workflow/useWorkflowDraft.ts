import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StepContent, StepDef, WorkflowDef, WorkflowStep } from '@lines/shared';
import { DEFAULT_MODEL, isStepRef } from '@lines/shared';
import { useStore } from '../../store';
import { getOwnerId, getOwnerName } from '../../lib/clerk';
import { send } from '../../ws';
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
 * re-published under the same id.
 */
export type DraftStep = StepContent & {
  _uid: string;
  ref?: DraftRef;
  publishStepId?: string;
};

export interface DraftWorkflow extends Omit<WorkflowDef, 'steps'> {
  steps: DraftStep[];
}

export interface StepErrors {
  name?: string;
  prompt?: string;
  ref?: string;
  outputName?: string;
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

function contentOf(s: StepContent): StepContent {
  return {
    name: s.name,
    promptTemplate: s.promptTemplate,
    model: s.model,
    permissionMode: s.permissionMode,
    autoAdvance: s.autoAdvance,
    freshStart: s.freshStart,
    outputName: s.outputName ?? '',
  };
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
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
      setCollapsed(new Set(d?.steps.map((s) => s._uid) ?? []));
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

  const addStep = () => {
    const step: DraftStep = { ...EMPTY_CONTENT, _uid: uid() };
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

  const removeStep = (u: string) =>
    setDraft((d) => (d ? { ...d, steps: d.steps.filter((s) => s._uid !== u) } : d));

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

  // ---- collapse/expand ----
  const toggleCollapsed = (u: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(u) ? next.delete(u) : next.add(u);
      return next;
    });

  const expandStep = (u: string) =>
    setCollapsed((prev) => {
      if (!prev.has(u)) return prev;
      const next = new Set(prev);
      next.delete(u);
      return next;
    });

  const collapseAll = () => setCollapsed(new Set(draft?.steps.map((s) => s._uid) ?? []));

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
    send({ type: 'saveWorkflow', workflow: wire, ownerName: getOwnerName() ?? undefined });
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
      setDraft((d) => (d ? { ...d, id: match.id, updatedAt: match.updatedAt } : d));
      setBaseline(JSON.stringify(toWire({ ...draft, id: match.id, updatedAt: match.updatedAt })));
      setSavePending(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflows]);

  const duplicate = () => {
    if (!draft) return;
    const copy: WorkflowDef = { ...toWire(draft), id: '', name: `${draft.name} (copy)`, published: false };
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
    collapsed,
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
    updateStepToLatest,
    updateAllToLatest,
    requestStepVersions,
    versionsFor,
    pinStepToVersion,
    toggleCollapsed,
    expandStep,
    collapseAll,
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

/** Serialize a draft to the wire shape: refs → StepRef, inline → StepContent. */
function toWire(d: DraftWorkflow): WorkflowDef {
  const steps: WorkflowStep[] = d.steps.map((s) =>
    s.ref
      ? { kind: 'ref', stepId: s.ref.stepId, ownerId: s.ref.ownerId, ownerName: s.ref.ownerName, version: s.ref.version }
      : {
          name: s.name,
          promptTemplate: s.promptTemplate,
          model: s.model,
          permissionMode: s.permissionMode,
          autoAdvance: s.autoAdvance,
          freshStart: s.freshStart,
          outputName: s.outputName ?? '',
        },
  );
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { steps: _drop, ...rest } = d;
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
      if (!content) e.ref = 'Shared step unavailable';
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
    if (e.name || e.prompt || e.ref || e.outputName) steps[s._uid] = e;
  }
  const name = d.name.trim() ? undefined : 'Workflow name is required';
  const noSteps = d.steps.length === 0 ? 'Add at least one step' : undefined;
  const ok = !name && !noSteps && Object.keys(steps).length === 0;
  return { name, noSteps, steps, ok };
}
