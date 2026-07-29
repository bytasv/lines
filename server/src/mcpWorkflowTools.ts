/**
 * The workflow/step tools a Lines session can call on itself, so workflows can be
 * discussed and edited in conversation instead of only in the editor modal.
 *
 * Bridge-side on purpose. The manifest is data (see workerProtocol.ts): the
 * worker turns it into a live MCP server and forwards each call back here, which
 * means tool names, descriptions and argument shapes can be reworded under tsx
 * watch without restarting the worker and killing in-flight turns.
 *
 * Every write validates against the same shared rules the editor uses and goes
 * through workflowCommands.ts, so this surface cannot diverge from the browser's.
 */
import type { StepContent, WorkflowDef, WorkflowStep } from '@lines/shared';
import {
  DEFAULT_MODEL,
  formatWorkflowIssues,
  isStepRef,
  validateStepContent,
  validateWorkflow,
  type StepForValidation,
} from '@lines/shared';
import type { JsonSchemaNode, McpToolManifest, McpToolResult, McpToolSpec } from './workerProtocol.ts';
import type { UserContext } from './userContext.ts';
import * as commands from './workflowCommands.ts';

/** Server name, so the model sees these as `mcp__lines__*`. */
export const LINES_MCP_SERVER = 'lines';

const TOOL_PREFIX = `mcp__${LINES_MCP_SERVER}__`;

const SCOPE: JsonSchemaNode = {
  type: 'string',
  enum: ['owned', 'shared', 'all'],
  description: "'owned' (default) = yours, 'shared' = other users' published ones, 'all' = both.",
};

const LIMIT: JsonSchemaNode = { type: 'integer', description: 'Max rows to return (default 50, max 100).' };

const WORKFLOW_REF: JsonSchemaNode = {
  type: 'string',
  description:
    'Workflow id, or its exact name (case-insensitive) when that name is unique among the workflows you own.',
};

/**
 * One step, inline or pinned, as a single flat object — the manifest schema is a
 * closed subset with no `oneOf`, so which fields matter is decided by `kind` in
 * code and reported as a validation error rather than by the schema.
 */
const STEP: JsonSchemaNode = {
  type: 'object',
  description:
    "A workflow step. Omit 'kind' (or pass 'inline') for a step written here; pass 'ref' with stepId/ownerId/version to pin a published step from the library.",
  required: [],
  properties: {
    kind: { type: 'string', enum: ['inline', 'ref'] },
    name: { type: 'string', description: 'Short step label shown in the stepper. Required for inline steps.' },
    promptTemplate: {
      type: 'string',
      description:
        'The prompt sent to the agent. Tokens: {task} (the run description), {feedback}, {previous} (previous step output), {diff} (working-tree diff), {outputs.<name>} (a named output published by an EARLIER step).',
    },
    model: { type: 'string', description: `Model id, e.g. ${DEFAULT_MODEL}. Defaults to ${DEFAULT_MODEL}.` },
    permissionMode: {
      type: 'string',
      enum: ['default', 'auto', 'plan', 'acceptEdits', 'bypassPermissions'],
      description: "Defaults to 'default'. 'plan' makes the step read-only until its plan is approved.",
    },
    autoAdvance: {
      type: 'boolean',
      description: 'Advance to the next step without waiting for approval. Defaults to false.',
    },
    freshStart: {
      type: 'boolean',
      description:
        'Run in a clean session seeded with a compact hand-off instead of inheriting the whole conversation. Defaults to false.',
    },
    outputName: {
      type: 'string',
      description:
        'Publish this step\'s final output under this name so later steps can pull it via {outputs.<name>}. Letters, digits, - and _ only.',
    },
    stepId: { type: 'string', description: "Pinned step id ('ref' only)." },
    ownerId: { type: 'string', description: "Pinned step's owner id ('ref' only)." },
    version: { type: 'integer', description: "Pinned step version ('ref' only)." },
  },
};

const STEPS: JsonSchemaNode = {
  type: 'array',
  items: STEP,
  description: 'The full ordered step list — this replaces the existing steps, it is not a patch.',
};

const READ_TOOLS: McpToolSpec[] = [
  {
    name: 'list_workflows',
    description: 'List workflows with their id, name and step count. Start here before editing anything.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { scope: SCOPE, limit: LIMIT } },
  },
  {
    name: 'get_workflow',
    description:
      'Read one workflow in full: every step with its prompt template, model, permission mode and flags. Pinned library steps are resolved to the content that will actually run.',
    readOnly: true,
    inputSchema: { type: 'object', required: ['workflow'], properties: { workflow: WORKFLOW_REF } },
  },
  {
    name: 'list_steps',
    description: "List reusable published steps — yours, or other users' shared library.",
    readOnly: true,
    inputSchema: { type: 'object', properties: { scope: SCOPE, limit: LIMIT } },
  },
  {
    name: 'get_step',
    description: 'Read one reusable step in full.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      required: ['stepId'],
      properties: {
        stepId: { type: 'string' },
        ownerId: { type: 'string', description: "Another author's step. Defaults to your own." },
        version: { type: 'integer', description: 'A specific immutable version. Defaults to the current head.' },
      },
    },
  },
  {
    name: 'list_step_versions',
    description: 'List the immutable version history of one reusable step, newest first.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      required: ['stepId'],
      properties: {
        stepId: { type: 'string' },
        ownerId: { type: 'string', description: "Another author's step. Defaults to your own." },
      },
    },
  },
];

const WRITE_TOOLS: McpToolSpec[] = [
  {
    name: 'create_workflow',
    description: 'Create a new workflow. Needs a name and at least one step.',
    inputSchema: {
      type: 'object',
      required: ['name', 'steps'],
      properties: {
        name: { type: 'string' },
        steps: STEPS,
        published: { type: 'boolean', description: 'Share with every other user on this instance. Defaults to false.' },
      },
    },
  },
  {
    name: 'update_workflow',
    description:
      'Change a workflow you own. Only the fields you pass are touched, but `steps` replaces the whole list — read it with get_workflow first and send it back with your edit applied.',
    inputSchema: {
      type: 'object',
      required: ['workflow'],
      properties: {
        workflow: WORKFLOW_REF,
        name: { type: 'string' },
        steps: STEPS,
        published: { type: 'boolean' },
      },
    },
  },
  {
    name: 'delete_workflow',
    description: 'Delete a workflow you own. Sessions already running it keep their current step.',
    inputSchema: { type: 'object', required: ['workflow'], properties: { workflow: WORKFLOW_REF } },
  },
  {
    name: 'save_step',
    description:
      'Create or update one of your reusable steps. Editing the content mints a new immutable version; workflows pinned to an older version keep running that one.',
    inputSchema: {
      type: 'object',
      required: ['name', 'promptTemplate'],
      properties: {
        stepId: { type: 'string', description: 'Update an existing step of yours. Omit to create a new one.' },
        name: { type: 'string' },
        promptTemplate: STEP.properties!.promptTemplate!,
        model: STEP.properties!.model!,
        permissionMode: STEP.properties!.permissionMode!,
        autoAdvance: STEP.properties!.autoAdvance!,
        freshStart: STEP.properties!.freshStart!,
        outputName: STEP.properties!.outputName!,
        published: { type: 'boolean', description: 'Offer this step in the shared library. Defaults to false.' },
      },
    },
  },
  {
    name: 'delete_step',
    description:
      'Remove one of your reusable steps from the library. Workflows pinned to a version of it keep working.',
    inputSchema: { type: 'object', required: ['stepId'], properties: { stepId: { type: 'string' } } },
  },
];

export const LINES_TOOL_MANIFEST: McpToolManifest = {
  serverName: LINES_MCP_SERVER,
  instructions:
    'Lines workflows: ordered lists of prompt steps a session runs one at a time, parking for approval between them. ' +
    'Use these tools when the user wants to see or change their own workflows and reusable steps. ' +
    'Read before writing (list_workflows, then get_workflow), and send `steps` back whole — it replaces the list. ' +
    'Every write asks the user for approval, so make one deliberate call rather than a series of guesses.',
  tools: [...READ_TOOLS, ...WRITE_TOOLS],
};

const SPECS = new Map(LINES_TOOL_MANIFEST.tools.map((t) => [t.name, t] as const));

/** True for a tool served by our own in-process MCP server. */
export function isLinesMcpTool(toolName: string): boolean {
  return toolName.startsWith(TOOL_PREFIX) && SPECS.has(toolName.slice(TOOL_PREFIX.length));
}

/** True for one that only observes state — read from the manifest, never a second list. */
export function isReadOnlyLinesTool(toolName: string): boolean {
  if (!toolName.startsWith(TOOL_PREFIX)) return false;
  return SPECS.get(toolName.slice(TOOL_PREFIX.length))?.readOnly === true;
}

export type McpToolDispatcher = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<McpToolResult>;

// ---- result helpers ----

function ok(data: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/**
 * A single actionable sentence, not a JSON envelope: the model reads this and
 * decides what to ask the user, so `errors` are joined rather than nested.
 */
function fail(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---- argument coercion ----

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function scopeOf(v: unknown): commands.WorkflowScope {
  return v === 'shared' || v === 'all' ? v : 'owned';
}

/** The `steps` argument as workflow steps, or the first structural problem found. */
function toWorkflowSteps(raw: unknown): { ok: true; steps: WorkflowStep[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: '`steps` must be an array.' };
  const steps: WorkflowStep[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') return { ok: false, error: `Step ${i + 1} is not an object.` };
    const s = entry as Record<string, unknown>;
    if (s.kind === 'ref') {
      const stepId = str(s.stepId);
      const ownerId = str(s.ownerId);
      const version = num(s.version);
      if (!stepId || !ownerId || version === undefined) {
        return { ok: false, error: `Step ${i + 1} is a ref, so it needs stepId, ownerId and version.` };
      }
      steps.push({ kind: 'ref', stepId, ownerId, version });
      continue;
    }
    steps.push(toStepContent(s));
  }
  return { ok: true, steps };
}

/** Inline step content with the editor's own defaults applied for anything omitted. */
function toStepContent(s: Record<string, unknown>): StepContent {
  const outputName = str(s.outputName).trim();
  return {
    name: str(s.name).trim(),
    promptTemplate: str(s.promptTemplate),
    model: str(s.model).trim() || DEFAULT_MODEL,
    permissionMode: (str(s.permissionMode).trim() || 'default') as StepContent['permissionMode'],
    autoAdvance: bool(s.autoAdvance, false),
    freshStart: bool(s.freshStart, false),
    ...(outputName ? { outputName } : {}),
  };
}

/**
 * Reject a workflow the editor would reject, before `WorkflowEngine.save()` sees
 * it. `strictModel` is on here and off in the editor: the editor only offers real
 * model ids, whereas a model id invented in conversation would otherwise sail
 * through `resolveModelId` and fail at run time.
 */
function validationError(ctx: UserContext, name: string, steps: WorkflowStep[]): string | null {
  const forValidation: StepForValidation[] = steps.map((step) => ({
    isRef: isStepRef(step),
    content: isStepRef(step)
      ? commands.lookupStepVersion(ctx, step.ownerId, step.stepId, step.version)
      : step,
  }));
  const issues = validateWorkflow(name, forValidation, { strictModel: true });
  return issues.length ? formatWorkflowIssues(issues) : null;
}

/** Why a workflow reference could not be resolved, phrased so the model can ask. */
function refError(ref: string, result: Extract<commands.WorkflowRefResult, { ok: false }>): string {
  const list = result.candidates.map((c) => `"${c.name}" (${c.id})`).join(', ');
  switch (result.reason) {
    case 'ambiguous':
      return `"${ref}" matches more than one workflow you own — ask which one, then pass its id: ${list}`;
    case 'foreign':
      return `"${ref}" is another user's published workflow, which is read-only here. Duplicate it in the editor first if you want your own copy.`;
    default:
      return list
        ? `No workflow you own matches "${ref}". Yours are: ${list}`
        : `No workflow you own matches "${ref}", and you have none yet.`;
  }
}

/**
 * The tool handlers for one user, closed over their context. Built per rpc: the
 * worker's MCP server is per session, and the bridge routes each call to the
 * context that owns that session.
 */
export function createMcpDispatcher(ctx: UserContext): McpToolDispatcher {
  /** Resolve a `workflow` argument to something writable, or the error to return. */
  const owned = (ref: string): { workflow: WorkflowDef } | { error: string } => {
    const result = commands.resolveWorkflowRef(ctx, ref);
    return result.ok ? { workflow: result.workflow } : { error: refError(ref, result) };
  };

  return async (toolName, args) => {
    switch (toolName) {
      // ---- reads ----
      case 'list_workflows':
        return ok(commands.listWorkflowsView(ctx, scopeOf(args.scope), num(args.limit)));

      case 'get_workflow': {
        const ref = str(args.workflow);
        const found = commands.resolveWorkflowRef(ctx, ref);
        if (found.ok) return ok(commands.readWorkflowView(ctx, found.workflow));
        // A read of someone else's published workflow is legitimate — only writes aren't.
        if (found.reason === 'foreign') {
          const shared = ctx.workflows.listShared().find((w) => w.id === found.candidates[0]?.id);
          if (shared) return ok(commands.readWorkflowView(ctx, shared, false));
        }
        return fail(refError(ref, found));
      }

      case 'list_steps':
        return ok(commands.listStepsView(ctx, scopeOf(args.scope), num(args.limit)));

      case 'get_step': {
        const stepId = str(args.stepId);
        const step = commands.readStepView(ctx, stepId, str(args.ownerId) || undefined, num(args.version));
        return step ? ok(step) : fail(`No step ${stepId} is available on this machine.`);
      }

      case 'list_step_versions': {
        const versions = await commands.stepVersionsView(ctx, str(args.ownerId) || ctx.userId, str(args.stepId));
        return ok(versions);
      }

      // ---- writes ----
      case 'create_workflow': {
        const name = str(args.name).trim();
        const steps = toWorkflowSteps(args.steps);
        if (!steps.ok) return fail(steps.error);
        const invalid = validationError(ctx, name, steps.steps);
        if (invalid) return fail(`That workflow is not valid: ${invalid}`);
        const saved = commands.saveWorkflow(ctx, {
          workflow: { id: '', name, steps: steps.steps, published: bool(args.published, false) },
          ownerName: commands.ownerDisplayName(ctx),
        });
        return ok({ saved: true, workflow: commands.readWorkflowView(ctx, saved) });
      }

      case 'update_workflow': {
        const ref = str(args.workflow);
        const target = owned(ref);
        if ('error' in target) return fail(target.error);

        const next: WorkflowDef = { ...target.workflow };
        if (typeof args.name === 'string') next.name = args.name.trim();
        if (typeof args.published === 'boolean') next.published = args.published;
        if (args.steps !== undefined) {
          const steps = toWorkflowSteps(args.steps);
          if (!steps.ok) return fail(steps.error);
          next.steps = steps.steps;
        }
        const invalid = validationError(ctx, next.name, next.steps);
        if (invalid) return fail(`That change would leave the workflow invalid: ${invalid}`);

        const saved = commands.saveWorkflow(ctx, { workflow: next, ownerName: commands.ownerDisplayName(ctx) });
        return ok({
          saved: true,
          // Named so the model can warn the user rather than silently reshaping a live run.
          runningSessions: commands.workflowInUse(ctx, saved.id),
          workflow: commands.readWorkflowView(ctx, saved),
        });
      }

      case 'delete_workflow': {
        const ref = str(args.workflow);
        const target = owned(ref);
        if ('error' in target) return fail(target.error);
        const runningSessions = commands.workflowInUse(ctx, target.workflow.id);
        commands.deleteWorkflow(ctx, target.workflow.id);
        return ok({ deleted: true, id: target.workflow.id, name: target.workflow.name, runningSessions });
      }

      case 'save_step': {
        const stepId = str(args.stepId).trim() || undefined;
        if (stepId && !ctx.workflows.listSteps().some((s) => s.id === stepId)) {
          return fail(`You have no step ${stepId}. Omit stepId to create a new one.`);
        }
        const content = toStepContent(args);
        const issues = validateStepContent(content, { strictModel: true });
        if (issues.length) return fail(`That step is not valid: ${formatWorkflowIssues(issues)}`);
        const saved = commands.saveStep(ctx, {
          step: content,
          stepId,
          published: bool(args.published, false),
          ownerName: commands.ownerDisplayName(ctx),
        });
        return ok({ saved: true, step: saved });
      }

      case 'delete_step': {
        const stepId = str(args.stepId);
        if (!ctx.workflows.listSteps().some((s) => s.id === stepId)) {
          return fail(`You have no step ${stepId}.`);
        }
        commands.deleteStep(ctx, stepId);
        return ok({ deleted: true, stepId });
      }

      default:
        return fail(`Unknown tool "${toolName}".`);
    }
  };
}
