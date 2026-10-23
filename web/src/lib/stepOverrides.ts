import type { ReasoningEffort, WorkflowStepOverride } from '@lines/shared';
import { AUTO_EFFORT } from './modelSelect';

/** One step row's picks in a per-run override picker: a model id, and an effort or AUTO_EFFORT. */
export interface StepRowChoice {
  model: string;
  effort: string;
}

/** The step's own values, i.e. what a row resets to. Unresolved steps get blanks. */
export function stepRowDefaults(
  contents: ({ model?: string; reasoningEffort?: ReasoningEffort } | null | undefined)[],
): StepRowChoice[] {
  return contents.map((c) => ({ model: c?.model ?? '', effort: c?.reasoningEffort ?? AUTO_EFFORT }));
}

/** The rows a picker opens with: each step's own values, with any existing override on top. */
export function seedStepRows(
  defaults: StepRowChoice[],
  initialOverrides?: (WorkflowStepOverride | null)[],
): StepRowChoice[] {
  return defaults.map((d, i) => {
    const o = initialOverrides?.[i];
    if (!o) return d;
    return {
      model: o.model ?? d.model,
      effort: o.reasoningEffort === undefined ? d.effort : (o.reasoningEffort ?? AUTO_EFFORT),
    };
  });
}

/**
 * Rows that differ from the step's own values, as overrides; a row left alone is
 * null, so an untouched picker launches exactly like a plain click. Locked rows
 * keep whatever override they already had.
 */
export function stepOverridesFromRows(
  rows: StepRowChoice[],
  defaults: StepRowChoice[],
  locked: ReadonlySet<number> = new Set(),
  initialOverrides?: (WorkflowStepOverride | null)[],
): (WorkflowStepOverride | null)[] {
  return rows.map((r, i) => {
    if (locked.has(i)) return initialOverrides?.[i] ?? null;
    const base = defaults[i];
    if (!base) return null;
    const o: WorkflowStepOverride = {};
    if (r.model && r.model !== base.model) o.model = r.model;
    if (r.effort !== base.effort) {
      o.reasoningEffort = r.effort === AUTO_EFFORT ? null : (r.effort as ReasoningEffort);
    }
    return Object.keys(o).length ? o : null;
  });
}

/** The effort to keep after a model switch: the current one if the new model offers it, else Auto. */
export function effortForModel(effort: string, offered: readonly ReasoningEffort[]): string {
  return effort === AUTO_EFFORT || offered.includes(effort as ReasoningEffort) ? effort : AUTO_EFFORT;
}
