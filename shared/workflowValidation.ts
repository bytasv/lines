/**
 * Workflow/step validation shared by the browser editor and the server.
 *
 * Historically the only gate was the editor's own `validate()`, which meant an
 * unattended writer (the MCP tool surface) could put an unrunnable workflow on
 * disk and into other users' shared views. The rules live here so both callers
 * enforce the same thing.
 *
 * NOTE: `./types.ts` re-exports this module, so the two form an import cycle.
 * Nothing here may read a runtime binding from `./types.ts` at module top level
 * — only inside function bodies, by which time both modules are initialized.
 */
import type { PermissionMode, StepContent } from './types.ts';
import { isKnownModel, LEGACY_MODEL_MAP } from './types.ts';

/** The runtime reads `{outputs.<name>}` with `[\w-]+`, so anything else is unreferenceable. */
export const OUTPUT_NAME_RE = /^[A-Za-z0-9_-]+$/;
export const OUTPUT_NAME_HINT = 'Letters, digits, - and _ only';

/** Kept in sync with the `PermissionMode` union by construction — adding a mode breaks the build here. */
const PERMISSION_MODE_SET: Record<PermissionMode, true> = {
  default: true,
  auto: true,
  plan: true,
  acceptEdits: true,
  bypassPermissions: true,
};

const OUTPUT_TOKEN_RE = /\{outputs\.([\w-]+)\}/g;

/** Guards against a runaway name in a permission card or a shared workflow list. */
export const MAX_WORKFLOW_NAME_LEN = 120;

export type WorkflowIssueField =
  | 'workflow'
  | 'name'
  | 'prompt'
  | 'ref'
  | 'outputName'
  | 'model'
  | 'permissionMode';

export interface WorkflowIssue {
  /** Absent for workflow-level issues (name, no steps). */
  stepIndex?: number;
  field: WorkflowIssueField;
  message: string;
}

export interface ValidateOptions {
  /**
   * Reject a model id that is neither known nor a legacy alias. Off for the
   * editor (which offers only known ids anyway, and must keep loading workflows
   * saved against a since-retired model); on for the MCP path, where a model
   * invented by the agent would otherwise pass straight through `resolveModelId`.
   */
  strictModel?: boolean;
}

function isValidPermissionMode(mode: string): mode is PermissionMode {
  return Object.prototype.hasOwnProperty.call(PERMISSION_MODE_SET, mode);
}

/** Issues intrinsic to one step's content, ignoring its position in a workflow. */
export function validateStepContent(c: StepContent, opts: ValidateOptions = {}): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  if (!c.name?.trim()) issues.push({ field: 'name', message: 'Required' });
  if (!c.promptTemplate?.trim()) issues.push({ field: 'prompt', message: 'Prompt is required' });

  const out = (c.outputName ?? '').trim();
  if (out && !OUTPUT_NAME_RE.test(out)) issues.push({ field: 'outputName', message: OUTPUT_NAME_HINT });

  if (!isValidPermissionMode(String(c.permissionMode))) {
    issues.push({
      field: 'permissionMode',
      message: `Unknown permission mode "${c.permissionMode}" — expected one of ${Object.keys(PERMISSION_MODE_SET).join(', ')}`,
    });
  }

  if (opts.strictModel) {
    const model = String(c.model ?? '');
    if (!model.trim()) {
      issues.push({ field: 'model', message: 'Required' });
    } else if (!isKnownModel(model) && !LEGACY_MODEL_MAP[model]) {
      issues.push({ field: 'model', message: `Unknown model "${model}"` });
    }
  }

  return issues;
}

/** One workflow step as seen by validation: resolved content, plus whether it was a pinned ref. */
export interface StepForValidation {
  content?: StepContent;
  isRef: boolean;
}

/**
 * Full-workflow validation. Beyond per-step content this covers the two
 * cross-step rules: output names must be unique (two publishers of one name
 * silently overwrite each other at runtime, last writer wins) and a
 * `{outputs.X}` token must be published by an *earlier* step, or the step parks
 * mid-run instead of failing here.
 */
export function validateWorkflow(
  name: string,
  steps: StepForValidation[],
  opts: ValidateOptions = {},
): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];

  const trimmed = (name ?? '').trim();
  if (!trimmed) issues.push({ field: 'workflow', message: 'Workflow name is required' });
  else if (trimmed.length > MAX_WORKFLOW_NAME_LEN) {
    issues.push({ field: 'workflow', message: `Workflow name must be ${MAX_WORKFLOW_NAME_LEN} characters or fewer` });
  }
  if (steps.length === 0) issues.push({ field: 'workflow', message: 'Add at least one step' });

  const counts = new Map<string, number>();
  for (const s of steps) {
    const out = s.content?.outputName?.trim();
    if (out) counts.set(out, (counts.get(out) ?? 0) + 1);
  }

  const published = new Set<string>();
  steps.forEach((s, stepIndex) => {
    const { content, isRef } = s;
    if (!content) {
      issues.push({
        stepIndex,
        field: isRef ? 'ref' : 'name',
        message: isRef ? 'Shared step unavailable' : 'Step content is missing',
      });
      return;
    }

    // A pinned ref's content is the author's, immutable and already published —
    // re-flagging its intrinsic problems here would be unactionable for the
    // consumer, so only the cross-step rules apply to refs.
    if (!isRef) {
      for (const issue of validateStepContent(content, opts)) issues.push({ ...issue, stepIndex });
    }

    const hasPromptIssue = issues.some((i) => i.stepIndex === stepIndex && i.field === 'prompt');
    const unknown = [...(content.promptTemplate ?? '').matchAll(OUTPUT_TOKEN_RE)]
      .map((m) => m[1])
      .filter((n, idx, all) => !published.has(n) && all.indexOf(n) === idx);
    if (!hasPromptIssue && unknown.length) {
      issues.push({
        stepIndex,
        field: 'prompt',
        message: `No earlier step publishes ${unknown.map((n) => `{outputs.${n}}`).join(', ')}`,
      });
    }

    const out = (content.outputName ?? '').trim();
    if (out && OUTPUT_NAME_RE.test(out) && (counts.get(out) ?? 0) > 1) {
      issues.push({ stepIndex, field: 'outputName', message: 'Another step already publishes this name' });
    }
    if (out) published.add(out);
  });

  return issues;
}

/** One-line rendering of an issue list, for a tool result or a log line. */
export function formatWorkflowIssues(issues: WorkflowIssue[]): string {
  return issues
    .map((i) => (i.stepIndex === undefined ? `${i.field}: ${i.message}` : `step ${i.stepIndex + 1} (${i.field}): ${i.message}`))
    .join('; ');
}
