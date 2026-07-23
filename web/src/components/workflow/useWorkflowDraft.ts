import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PermissionMode, WorkflowDef, WorkflowStep } from '@claude-ui/shared';
import { DEFAULT_MODEL } from '@claude-ui/shared';
import { useStore } from '../../store';
import { getOwnerName } from '../../lib/clerk';
import { send } from '../../ws';
import type { WorkflowPreset } from '../../lib/workflowPresets';

export const MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Agent' },
  { value: 'auto', label: 'Auto (guarded)' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' },
];

export type DraftStep = WorkflowStep & { _uid: string };
export interface Draft extends Omit<WorkflowDef, 'steps'> {
  steps: DraftStep[];
}

export interface StepErrors {
  name?: string;
  prompt?: string;
}
export interface ValidationResult {
  name?: string;
  noSteps?: string;
  steps: Record<string, StepErrors>;
  ok: boolean;
}

let uidSeq = 0;
function uid(): string {
  // crypto.randomUUID is fine but a counter keeps snapshots deterministic in tests.
  uidSeq += 1;
  return `s${uidSeq}`;
}

function emptyStep(): DraftStep {
  return {
    _uid: uid(),
    name: 'New step',
    promptTemplate: '',
    model: DEFAULT_MODEL,
    permissionMode: 'default',
    autoAdvance: false,
  };
}

function toDraft(w: WorkflowDef): Draft {
  return { ...w, steps: w.steps.map((s) => ({ ...s, _uid: uid() })) };
}

function stripUids(d: Draft): WorkflowDef {
  return { ...d, steps: d.steps.map(({ _uid, ...s }) => s) };
}

export function validateDraft(d: Draft): ValidationResult {
  const steps: Record<string, StepErrors> = {};
  for (const s of d.steps) {
    const e: StepErrors = {};
    if (!s.name.trim()) e.name = 'Required';
    if (!s.promptTemplate.trim()) e.prompt = 'Prompt is required';
    if (e.name || e.prompt) steps[s._uid] = e;
  }
  const name = d.name.trim() ? undefined : 'Workflow name is required';
  const noSteps = d.steps.length === 0 ? 'Add at least one step' : undefined;
  const ok = !name && !noSteps && Object.keys(steps).length === 0;
  return { name, noSteps, steps, ok };
}

type PendingAction =
  | { kind: 'close' }
  | { kind: 'select'; target: WorkflowDef }
  | { kind: 'new'; preset: WorkflowPreset | null }
  | null;

export function useWorkflowDraft(opened: boolean, onClose: () => void) {
  const workflows = useStore((s) => s.workflows);
  const sharedWorkflows = useStore((s) => s.sharedWorkflows);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [sampleTask, setSampleTask] = useState('Add a dark-mode toggle to the settings page');
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadFrom = useCallback((w: WorkflowDef | null, id: string | null) => {
    const d = w ? toDraft(w) : null;
    setDraft(d);
    setSelectedId(id);
    setBaseline(d ? JSON.stringify(stripUids(d)) : null);
    setCollapsed(new Set());
    setSubmitAttempted(false);
  }, []);

  // On open, pick the previously-selected workflow or the first owned one.
  useEffect(() => {
    if (!opened) return;
    const all = [...workflows, ...sharedWorkflows];
    const source = all.find((w) => w.id === selectedId) ?? workflows[0] ?? null;
    loadFrom(source, source?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, workflows.length, sharedWorkflows.length]);

  const readOnly = !!draft?.id && sharedWorkflows.some((w) => w.id === draft.id);

  const dirty = useMemo(
    () => (draft && baseline ? JSON.stringify(stripUids(draft)) !== baseline : false),
    [draft, baseline],
  );

  const validation = useMemo(() => (draft ? validateDraft(draft) : null), [draft]);

  const patchDraft = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const updateStep = (u: string, patch: Partial<WorkflowStep>) =>
    setDraft((d) =>
      d ? { ...d, steps: d.steps.map((s) => (s._uid === u ? { ...s, ...patch } : s)) } : d,
    );

  const addStep = () => {
    const step = emptyStep();
    setDraft((d) => (d ? { ...d, steps: [...d.steps, step] } : d));
    return step._uid;
  };

  const duplicateStep = (u: string) =>
    setDraft((d) => {
      if (!d) return d;
      const i = d.steps.findIndex((s) => s._uid === u);
      if (i < 0) return d;
      const copy: DraftStep = { ...d.steps[i], _uid: uid(), name: `${d.steps[i].name} (copy)` };
      const steps = [...d.steps];
      steps.splice(i + 1, 0, copy);
      return { ...d, steps };
    });

  const removeStep = (u: string) =>
    setDraft((d) => (d ? { ...d, steps: d.steps.filter((s) => s._uid !== u) } : d));

  const moveStep = (u: string, dir: -1 | 1) =>
    setDraft((d) => {
      if (!d) return d;
      const i = d.steps.findIndex((s) => s._uid === u);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.steps.length) return d;
      const steps = [...d.steps];
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...d, steps };
    });

  const reorder = (from: number, to: number) =>
    setDraft((d) => {
      if (!d || from === to) return d;
      const steps = [...d.steps];
      const [moved] = steps.splice(from, 1);
      steps.splice(to, 0, moved);
      return { ...d, steps };
    });

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
    const blankStep: WorkflowStep = {
      name: 'New step',
      promptTemplate: '',
      model: DEFAULT_MODEL,
      permissionMode: 'default',
      autoAdvance: false,
    };
    const wf: WorkflowDef = {
      id: '',
      name: preset ? preset.name : 'New workflow',
      steps: preset ? preset.steps.map((s) => ({ ...s })) : [blankStep],
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
    const v = validateDraft(draft);
    if (!v.ok) return false;
    send({ type: 'saveWorkflow', workflow: stripUids(draft), ownerName: getOwnerName() ?? undefined });
    // Existing workflow: reset baseline in place. New workflow: adopt id from the
    // broadcast reconciliation effect below.
    setBaseline(JSON.stringify(stripUids(draft)));
    setSubmitAttempted(false);
    return true;
  };

  // Reconcile a just-saved NEW workflow (id:'') with the server-assigned id once
  // it arrives in the broadcast: match on name + step count, newest updatedAt.
  useEffect(() => {
    if (!draft || selectedId !== null || draft.id || baseline === null) return;
    // Only reconcile right after a save (baseline equals current draft = not dirty).
    if (JSON.stringify(stripUids(draft)) !== baseline) return;
    const match = workflows
      .filter((w) => w.name === draft.name && w.steps.length === draft.steps.length)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    if (match) {
      setSelectedId(match.id);
      setDraft((d) => (d ? { ...d, id: match.id, updatedAt: match.updatedAt } : d));
      setBaseline(JSON.stringify(stripUids({ ...draft, id: match.id, updatedAt: match.updatedAt })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflows]);

  const duplicate = () => {
    if (!draft) return;
    const copy: WorkflowDef = {
      id: '',
      name: `${draft.name} (copy)`,
      steps: draft.steps.map(({ _uid, ...s }) => ({ ...s })),
      published: false,
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
    selectedId,
    draft,
    readOnly,
    dirty,
    validation,
    submitAttempted,
    sampleTask,
    setSampleTask,
    collapsed,
    pendingAction,
    confirmDelete,
    // actions
    patchDraft,
    updateStep,
    addStep,
    duplicateStep,
    removeStep,
    moveStep,
    reorder,
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
