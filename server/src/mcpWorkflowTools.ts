/**
 * The tools a Lines session can call on itself: workflows and steps, so they can
 * be discussed and edited in conversation instead of only in the editor modal,
 * plus the MCP connections of the user running the session, so the agent can
 * notice that the tools a task needs are missing and offer to set the server up.
 *
 * Bridge-side on purpose. The manifest is data (see workerProtocol.ts): the
 * worker turns it into a live MCP server and forwards each call back here, which
 * means tool names, descriptions and argument shapes can be reworded under tsx
 * watch without restarting the worker and killing in-flight turns.
 *
 * Every write validates against the same shared rules the editor uses and goes
 * through workflowCommands.ts, so this surface cannot diverge from the browser's.
 */
import type { McpConnection, StepContent, WorkflowDef, WorkflowStep } from '@lines/shared';
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
        'The prompt sent to the agent. Tokens: {task} (the run description), {feedback}, {previous} (previous step output), {roots} (the workspace folders, their git repos and branches), {outputs.<name>} (a named output published by an EARLIER step).',
    },
    model: { type: 'string', description: `Model id, e.g. ${DEFAULT_MODEL}. Defaults to ${DEFAULT_MODEL}.` },
    permissionMode: {
      type: 'string',
      enum: ['plan', 'auto', 'bypassPermissions'],
      description: "Defaults to 'auto'. 'plan' makes the step read-only until its plan is approved.",
    },
    reasoningEffort: {
      type: 'string',
      enum: ['low', 'medium', 'high', 'xhigh', 'max'],
      description:
        "How hard the model thinks on this step. Omit to run at the model's own default. Cleared for the next step unless that step sets one too.",
    },
    routing: {
      type: 'object',
      description:
        "Optional smart-routing rule for this step's turns, overriding the user's global rule while the step runs: before each turn a classifier may move it to one of `models`/`efforts` per `rule`. Models must be on the same provider as `model`. Omit to use the global rule.",
      required: ['rule', 'models', 'efforts'],
      properties: {
        rule: { type: 'string', description: 'Plain-language rule, e.g. "max effort for debugging; low for small edits".' },
        models: { type: 'array', items: { type: 'string' }, description: 'Allowed model ids.' },
        efforts: {
          type: 'array',
          items: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
          description: 'Allowed efforts.',
        },
        minConfidence: { type: 'number', description: 'Ignore picks below this confidence (0-1). Default 0.7.' },
      },
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

/**
 * The connection-proposal surface's own limits, stated on the schema so the
 * model does not waste a call learning them, and re-enforced in the dispatcher
 * because these arguments can originate from a page the agent read:
 *
 *  - **No `stdio`.** A proposed local command is arbitrary code execution, not a
 *    URL. `command`/`args`/`env` are absent from the schema and refused below.
 *  - **No headers and no credential values.** They would land in the transcript
 *    and in the synced connection blob. OAuth or nothing; a server that needs a
 *    static token stays a manual add in Settings.
 */
const PROPOSED_TRANSPORT: JsonSchemaNode = {
  type: 'string',
  enum: ['http', 'sse'],
  description: "'http' for a streamable-HTTP endpoint (the usual one), 'sse' for a legacy SSE one.",
};

/**
 * Limits on `propose_ui`. Its payload rides transcript events, history paging and
 * end-to-end encryption, and stays in the agent's context, so the HTML is capped
 * per version and per call (measured in UTF-8 bytes).
 */
export const PROPOSAL_MIN_VERSIONS = 1;
export const PROPOSAL_MAX_VERSIONS = 4;
export const PROPOSAL_MAX_VERSION_BYTES = 200_000;
export const PROPOSAL_MAX_TOTAL_BYTES = 600_000;

/**
 * `propose_ui`'s description: what the frame offers is the same on both paths,
 * and `flow` says how the pick comes back — waited for on the Claude path (its
 * card is always-ask, see sessions.ts), a later chat message on codex's.
 */
function proposeUiDescription(flow: string): string {
  return (
    'Show the user one to four versions of a UI side by side in the chat, as rendered HTML, so they can compare them and pick one — without opening the app. ' +
    "Each `html` is a fragment or a full document rendered in a sandboxed frame with the app's design tokens already injected: " +
    '`var(--mantine-color-*)` (e.g. --mantine-color-body, --mantine-color-text, --mantine-color-dimmed, --mantine-color-default-border, --mantine-color-blue-6), ' +
    '`--mantine-spacing-*`, `--mantine-radius-*`, `--mantine-font-size-*` and `--mantine-font-family`; the body background, text colour and font are already set, ' +
    'and `data-mantine-color-scheme` is on `<html>`. ' +
    'Aim for a quick, approximate mock: use the tokens for colour, type, spacing and radius, and do not rebuild Mantine components faithfully or read component source just to match them. ' +
    'Inline everything — no network is needed and relative URLs do not resolve. ' +
    `Each version is capped at ${Math.round(PROPOSAL_MAX_VERSION_BYTES / 1000)} KB of HTML and the call at ${Math.round(PROPOSAL_MAX_TOTAL_BYTES / 1000)} KB. ` +
    flow
  );
}

const PROPOSAL_REVISE: JsonSchemaNode = {
  type: 'boolean',
  description:
    'Update the previous proposal with this exact `title` in place instead of starting a new set: pass only the versions you changed, under their existing labels (a new label adds a version). The user keeps comparing the whole set, with the changed versions swapped in. Use it after the user asks for changes.',
};

/**
 * Where the user's answer rides back into the call. It has to be in the schema:
 * the worker builds a Zod object from it, which strips any key it does not
 * name, so an answer resolvePermission put on the input would never reach the
 * dispatcher. Whatever the agent sends here is replaced by the card's answer
 * (resolvePermission rebuilds it), and the codex manifest drops it.
 */
const PROPOSAL_ANSWER: JsonSchemaNode = {
  type: 'object',
  description: "Never set this — Lines fills it in with the user's answer from the card.",
  properties: {
    choice: { type: 'string' },
    note: { type: 'string' },
    feedback: { type: 'string' },
    version: { type: 'string' },
    // Must be named here too, or the worker's Zod object strips it.
    revision: { type: 'string' },
  },
};

const READ_TOOLS: McpToolSpec[] = [
  {
    name: 'list_workflows',
    description:
      'List workflows with their id, name, step count and their `createdAt`/`updatedAt` times (local, `YYYY-MM-DD HH:MM`). Start here before editing anything.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { scope: SCOPE, limit: LIMIT } },
  },
  {
    name: 'get_workflow',
    description:
      'Read one workflow in full: every step with its prompt template, model, permission mode and flags, plus the workflow\'s `createdAt`/`updatedAt` times (local, `YYYY-MM-DD HH:MM`). Pinned library steps are resolved to the content that will actually run.',
    readOnly: true,
    inputSchema: { type: 'object', required: ['workflow'], properties: { workflow: WORKFLOW_REF } },
  },
  {
    name: 'list_steps',
    description:
      "List reusable published steps — yours, or other users' shared library. Each row carries `createdAt` (when the step was first created) and `updatedAt` (when its current version was minted), local, `YYYY-MM-DD HH:MM`.",
    readOnly: true,
    inputSchema: { type: 'object', properties: { scope: SCOPE, limit: LIMIT } },
  },
  {
    name: 'get_step',
    description:
      'Read one reusable step in full, with `createdAt`/`updatedAt` (local, `YYYY-MM-DD HH:MM`). `createdAt` is when the step itself was first created, not when this version was minted — every version of one step reports the same value, so identical dates down a version list are correct. `updatedAt` is that version\'s own mint time.',
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
  {
    name: 'list_mcp_connections',
    description:
      "The MCP servers this user has added, with their transport, URL, whether they are on, and this session's connection status where one is known. Call this whenever a task needs a third-party service you have no tools for — including when a fetch of that service's page came back as a sign-in wall or an empty JavaScript shell, which is what a missing connection looks like from the outside. It tells you whether the server is missing, switched off, or connected but not authorized.",
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'propose_ui',
    description: proposeUiDescription(
      'The call waits while the user compares them, then returns the version they picked (with an optional note) or the changes they asked for instead. ' +
        'Use it whenever a visual choice is open — including in plan mode, to settle the design before writing the plan; write the chosen version into the plan rather than proposing it there. ' +
        'To act on requested changes, call it again with the same `title` and `revise: true`, passing only the versions you changed: the card replaces them in place in the set the user is already comparing.',
    ),
    readOnly: true,
    inputSchema: {
      type: 'object',
      required: ['title', 'versions'],
      properties: {
        title: { type: 'string', description: 'What is being proposed, e.g. "Prompt area".' },
        versions: {
          type: 'array',
          description: `${PROPOSAL_MIN_VERSIONS}-${PROPOSAL_MAX_VERSIONS} versions, shown as tabs in this order.`,
          items: {
            type: 'object',
            required: ['label', 'html'],
            properties: {
              label: { type: 'string', description: 'Short unique tab label, e.g. "A" or "Quiet chips".' },
              html: { type: 'string', description: 'The mock: an HTML fragment or a full document.' },
              notes: { type: 'string', description: 'Optional one or two lines on what this version changes.' },
            },
          },
        },
        revise: PROPOSAL_REVISE,
        answer: PROPOSAL_ANSWER,
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
        reasoningEffort: STEP.properties!.reasoningEffort!,
        routing: STEP.properties!.routing!,
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
  {
    name: 'add_mcp_connection',
    description:
      "Propose an MCP server for the user to approve, after list_mcp_connections showed it is missing. Look the endpoint up in the vendor's own documentation and pass that documentation page as `source` — the approval card shows the URL verbatim next to a trust check, and the user is the one who decides. Only http/sse endpoints that sign in with OAuth: Lines cannot accept a local command, a header or a token here, so say so and let the user add that kind from Settings themselves.",
    inputSchema: {
      type: 'object',
      required: ['name', 'transport', 'url', 'source'],
      properties: {
        name: {
          type: 'string',
          description:
            'The MCP namespace to install it under — its tools arrive as mcp__<name>__<tool>. Lowercase letters, digits, - and _.',
        },
        transport: PROPOSED_TRANSPORT,
        url: { type: 'string', description: "The server's HTTPS endpoint, exactly as documented." },
        source: {
          type: 'string',
          description:
            'Where you found this endpoint — the documentation URL. Shown to the user on the approval card, so it must be the page you actually read.',
        },
      },
    },
  },
  {
    name: 'authorize_mcp_connection',
    description:
      'Sign the user in to one of their http/sse MCP servers. Shows them the provider sign-in link and waits for the handshake to land, after which that server\'s tools are usable in this same turn. Use it after add_mcp_connection, or when list_mcp_connections reports needs-auth.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  },
];

/** The sentence each manifest carries about `propose_ui`, matching how its pick comes back. */
// Worded against AskUserQuestion on purpose: that is the built-in the model
// reaches for when a choice is open, and Claude Code may defer this tool behind
// ToolSearch, so these instructions are often all the model sees of it.
const PROPOSE_UI_INSTRUCTION =
  'UI choices: when the user asks for UI or design options, or a plan has a visual decision open (layout, styling, ' +
  'look of a component or screen), show the candidates as rendered mocks with mcp__lines__propose_ui instead of ' +
  'describing them in text or offering them through AskUserQuestion — the user picks from what they see. It waits ' +
  "for the user's pick and returns it, and it works in plan mode: call it while planning, then write the chosen " +
  'version into the plan. Keep AskUserQuestion for choices that are not visual.';
const PROPOSE_UI_INSTRUCTION_NO_WAIT =
  'When the user asks to see UI options or a design change before it is built, show them with propose_ui ' +
  "(rendered HTML mocks in the app's palette), then end your turn and wait for them to accept one or reply before editing code.";

export const LINES_TOOL_MANIFEST: McpToolManifest = {
  serverName: LINES_MCP_SERVER,
  instructions:
    'Lines workflows: ordered lists of prompt steps a session runs one at a time, parking for approval between them. ' +
    'Use these tools when the user wants to see or change their own workflows and reusable steps. ' +
    'Read before writing (list_workflows, then get_workflow), and send `steps` back whole — it replaces the list. ' +
    'Every write asks the user for approval, so make one deliberate call rather than a series of guesses. ' +
    'The mcp_connection tools cover the third-party MCP servers this user has added: when a task needs tools ' +
    'you cannot see, check list_mcp_connections before telling the user it cannot be done. ' +
    PROPOSE_UI_INSTRUCTION,
  tools: [...READ_TOOLS, ...WRITE_TOOLS],
};

/**
 * The manifest for a caller with no approval card in front of it: the reads,
 * and nothing else.
 *
 * That caller is a codex session, reaching us through `/lines-mcp`. The approval
 * claim above is true of the Claude path only — there, every non-readOnly Lines
 * tool raises a card the user answers. A codex call arrives as a plain HTTP
 * request with no card anywhere, so serving it the writes would let a
 * prompt-injected turn rewrite workflows (which later run as prompts) or add an
 * MCP server (which runs on every session) without anyone saying yes.
 */
export const LINES_READ_ONLY_MANIFEST: McpToolManifest = {
  serverName: LINES_MCP_SERVER,
  instructions:
    'Lines workflows: ordered lists of prompt steps a session runs one at a time, parking for approval between them. ' +
    'Use these tools when the user wants to see their own workflows and reusable steps. They are read-only here: ' +
    'to change a workflow, a step or a connection, tell the user what to change and they will do it in Lines. ' +
    'list_mcp_connections covers the third-party MCP servers this user has added: when a task needs tools ' +
    'you cannot see, check it before telling the user it cannot be done. ' +
    PROPOSE_UI_INSTRUCTION_NO_WAIT,
  // Same tools; only propose_ui's wording differs, since nothing here waits on a card.
  tools: READ_TOOLS.map((t) =>
    t.name === 'propose_ui'
      ? {
          ...t,
          // No card here, so no answer to carry.
          inputSchema: {
            ...t.inputSchema,
            properties: Object.fromEntries(
              Object.entries(t.inputSchema.properties ?? {}).filter(([key]) => key !== 'answer'),
            ),
          },
          description: proposeUiDescription(
            'The call returns at once: after it, end your turn and wait for the user to accept a version or reply before editing any code. To act on requested changes, call it again with the same `title` and `revise: true`, passing only the versions you changed.',
          ),
        }
      : t,
  ),
};

/**
 * The proposal tool by its full name, so `SessionManager` can vet its URL before
 * raising the card without restating the string.
 */
export const ADD_MCP_CONNECTION_TOOL = `${TOOL_PREFIX}add_mcp_connection`;

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

/** How an agent-driven authorization ended. `pending` = the user has not finished signing in. */
export type McpAuthorizeOutcome =
  | { authorized: true; alreadyAuthorized?: boolean }
  | { pending: true }
  | { error: string };

/**
 * The calling session, for the two tools that are about *this* session rather
 * than about stored data. Supplied by the bridge (see `handleMcpToolRpc`), which
 * owns the OAuth callback route the handshake completes through; absent in tests
 * and in any caller with no session, where those tools decline rather than guess.
 */
export interface McpToolSession {
  sessionId: string;
  /** Run OAuth leg 1 for one connection and wait for the browser redirect to settle. */
  authorize: (serverName: string) => Promise<McpAuthorizeOutcome>;
}

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
  // Kept absent rather than defaulted: absent is what "the model's own effort"
  // means, and an unknown value is left in place for validation to reject by name.
  const effort = str(s.reasoningEffort).trim();
  const routing = toRoutingRule(s.routing);
  return {
    name: str(s.name).trim(),
    promptTemplate: str(s.promptTemplate),
    model: str(s.model).trim() || DEFAULT_MODEL,
    permissionMode: (str(s.permissionMode).trim() || 'auto') as StepContent['permissionMode'],
    ...(effort ? { reasoningEffort: effort as StepContent['reasoningEffort'] } : {}),
    ...(routing ? { routing } : {}),
    autoAdvance: bool(s.autoAdvance, false),
    freshStart: bool(s.freshStart, false),
    ...(outputName ? { outputName } : {}),
  };
}

/**
 * A step's routing rule as sent, shaped but not judged: an unknown model or
 * effort is left in place for validateStepContent to reject by name. Absent or
 * not an object = no rule.
 */
function toRoutingRule(value: unknown): StepContent['routing'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean) : []);
  return {
    rule: str(r.rule).trim(),
    models: list(r.models),
    efforts: list(r.efforts) as NonNullable<StepContent['routing']>['efforts'],
    ...(typeof r.minConfidence === 'number' ? { minConfidence: r.minConfidence } : {}),
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

/** Why `McpConnections` refused a row, phrased for the model rather than as a code. */
function connectionRefusal(reason: string): string {
  switch (reason) {
    case 'duplicate-name':
      return 'A connection with that name already exists — read list_mcp_connections and use the existing one.';
    case 'reserved-name':
      return 'That name is reserved by Lines itself. Propose a different namespace.';
    case 'bad-name':
      return 'That name is not a valid MCP namespace: lowercase letters, digits, - and _, starting with a letter.';
    case 'empty-name':
      return 'A connection needs a name.';
    case 'bad-url':
      return 'That is not a URL Lines can build an MCP server from. Pass the documented https endpoint.';
    case 'too-many':
      return 'This user already has the maximum number of connections. Ask them to remove one from Settings.';
    default:
      return `Lines refused that connection (${reason}).`;
  }
}

/** Argument names that carry a local command or a credential — never accepted from the agent. */
const REFUSED_PROPOSAL_ARGS = ['command', 'args', 'env', 'headers', 'headerKeys'];

/** One connection as the model sees it — no header names, no ids, nothing secret. */
function connectionView(
  connection: McpConnection,
  status: { status: string; error?: string; tools?: string[] } | undefined,
): Record<string, unknown> {
  return {
    name: connection.name,
    transport: connection.transport,
    ...(connection.transport === 'stdio' ? { command: connection.command } : { url: connection.url }),
    enabled: connection.enabled,
    ...(status
      ? { status: status.status, ...(status.error ? { error: status.error } : {}), tools: status.tools ?? [] }
      : {}),
  };
}

/**
 * Why a `propose_ui` call would be refused, or null when it is well-formed. The
 * session checks this before raising the card, so a malformed call goes straight
 * to the dispatcher's error instead of a card the browser cannot render.
 */
export function proposalError(args: Record<string, unknown>): string | null {
  const checked = checkProposal(args);
  return 'error' in checked ? checked.error : null;
}

/** A `propose_ui` call's version labels, or the first reason it is refused. */
function checkProposal(args: Record<string, unknown>): { labels: string[] } | { error: string } {
  if (!str(args.title).trim()) return { error: '`title` is required: say what is being proposed.' };
  const versions = args.versions;
  if (!Array.isArray(versions)) return { error: '`versions` must be an array.' };
  if (versions.length < PROPOSAL_MIN_VERSIONS || versions.length > PROPOSAL_MAX_VERSIONS) {
    return {
      error: `Pass between ${PROPOSAL_MIN_VERSIONS} and ${PROPOSAL_MAX_VERSIONS} versions (got ${versions.length}).`,
    };
  }
  const labels: string[] = [];
  let total = 0;
  for (const [i, entry] of versions.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: `Version ${i + 1} is not an object.` };
    }
    const v = entry as Record<string, unknown>;
    const label = str(v.label).trim();
    if (!label) return { error: `Version ${i + 1} needs a non-empty \`label\`.` };
    if (labels.some((l) => l.toLowerCase() === label.toLowerCase())) {
      return { error: `Two versions are labelled "${label}" — labels must be unique.` };
    }
    if (typeof v.html !== 'string' || !v.html.trim()) {
      return { error: `Version "${label}" needs its \`html\`.` };
    }
    if (v.notes !== undefined && typeof v.notes !== 'string') {
      return { error: `Version "${label}": \`notes\` must be a string.` };
    }
    const bytes = Buffer.byteLength(v.html, 'utf8');
    if (bytes > PROPOSAL_MAX_VERSION_BYTES) {
      return {
        error: `Version "${label}" is ${Math.ceil(bytes / 1000)} KB of HTML; the limit is ${PROPOSAL_MAX_VERSION_BYTES / 1000} KB per version. Make the mock smaller — it only needs to be approximate.`,
      };
    }
    total += bytes;
    labels.push(label);
  }
  if (total > PROPOSAL_MAX_TOTAL_BYTES) {
    return {
      error: `The versions add up to ${Math.ceil(total / 1000)} KB of HTML; the limit is ${PROPOSAL_MAX_TOTAL_BYTES / 1000} KB per call. Send fewer or smaller versions.`,
    };
  }
  return { labels };
}

/** Characters kept of a free-text note or feedback on a proposal card. */
const PROPOSAL_NOTE_MAX_CHARS = 4000;

/**
 * The answer to a `propose_ui` card, narrowed to what the card can say: a
 * `choice` that is one of the call's own version labels (with an optional
 * `note`), or `feedback` instead of a pick — about the `version` the user had
 * selected when they asked, if it is one of the call's labels. Anything else is
 * undefined. Used by
 * resolvePermission on the client's answer and here on the rebuilt input.
 */
export function proposalAnswers(
  input: Record<string, unknown>,
  raw: unknown,
  /** A `revise` call's earlier labels: the card shows the merged set, so any of them can be chosen. */
  earlierLabels: string[] = [],
): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const clip = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, PROPOSAL_NOTE_MAX_CHARS) : '');
  const versions = Array.isArray(input.versions) ? (input.versions as unknown[]) : [];
  const labels = [
    ...versions.map((v) => (v && typeof v === 'object' ? str((v as Record<string, unknown>).label).trim() : '')),
    ...earlierLabels,
  ];
  const labelOf = (wanted: string) =>
    wanted ? labels.find((l) => l && l.toLowerCase() === wanted.toLowerCase()) : undefined;
  const choice = clip(r.choice);
  if (choice) {
    const label = labelOf(choice);
    if (!label) return undefined;
    const note = clip(r.note);
    return { choice: label, ...(note ? { note } : {}), ...revisionOf(r.revision) };
  }
  const feedback = clip(r.feedback);
  if (!feedback) return undefined;
  const version = labelOf(clip(r.version));
  return { feedback, ...(version ? { version, ...revisionOf(r.revision) } : {}) };
}

/**
 * An earlier revision of a version the user went back to on the card (1 = the
 * version as first proposed). Absent means the latest; anything that is not a
 * small positive integer is dropped rather than guessed at.
 */
function revisionOf(raw: unknown): { revision?: string } {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 99 ? { revision: String(n) } : {};
}

/**
 * The labels a `revise` call merges into: every earlier `propose_ui` input with
 * the same title, oldest first, back to (and including) the last one that was
 * not itself a revision. Empty for a call that is not a revision. Mirrors the
 * web's merge (buildTranscript), which is what the user actually picks from.
 */
export function earlierProposalLabels(input: Record<string, unknown>, earlier: Record<string, unknown>[]): string[] {
  if (input.revise !== true) return [];
  const title = str(input.title).trim().toLowerCase();
  const chain: Record<string, unknown>[] = [];
  for (let i = earlier.length - 1; i >= 0; i--) {
    const e = earlier[i];
    if (str(e.title).trim().toLowerCase() !== title) continue;
    chain.push(e);
    if (e.revise !== true) break;
  }
  const out: string[] = [];
  for (const e of chain) {
    for (const v of Array.isArray(e.versions) ? (e.versions as unknown[]) : []) {
      const label = v && typeof v === 'object' ? str((v as Record<string, unknown>).label).trim() : '';
      if (label && !out.some((l) => l.toLowerCase() === label.toLowerCase())) out.push(label);
    }
  }
  return out;
}

/**
 * What the agent reads for an answered proposal — the tool result on the live
 * path, and the recovery/retry message when the query that asked is gone. The
 * opening words are stable: the card reads the outcome back off them
 * (web/src/lib/transcript.ts, proposalOutcome).
 */
export function proposalAnswerText(title: string, answers: Record<string, string>): string {
  const what = title ? `the UI proposal "${title}"` : 'the UI proposal';
  // Wording read back by the card (proposalOutcome), so keep the parenthesis shape.
  const earlier = answers.revision
    ? ` (revision ${answers.revision} — an earlier revision of it, not your latest change)`
    : '';
  if (answers.choice) {
    return (
      `The user picked version "${answers.choice}"${earlier} of ${what}.` +
      (answers.note ? `\nTheir note: ${answers.note}` : '') +
      '\nUse that version: if you are planning, write it into the plan; otherwise implement it in the codebase to match.'
    );
  }
  // Said as an instruction to stay on this decision: read as plain feedback, the
  // agent took it as an answer and moved on to its next question.
  const target = answers.version ? `version "${answers.version}"${earlier} of ${what}` : what;
  const apply = answers.version
    ? `Apply these changes to version "${answers.version}"` +
      (answers.revision ? `, starting from its revision ${answers.revision} rather than the latest,` : '') +
      ' and call propose_ui again with the same title, ' +
      `\`revise: true\` and only the revised version "${answers.version}" (same label) — the card swaps it in place.`
    : 'Revise the mocks and call propose_ui again with the same title, `revise: true` and only the versions you changed.';
  return (
    `The user asked for changes to ${target} instead of picking one:\n${answers.feedback ?? ''}\n` +
    `${apply} If the feedback was a question, answer it first. Stay on this design decision until the user ` +
    'picks a version: do not move on to other questions, the plan or code before then.'
  );
}

/**
 * The tool handlers for one user, closed over their context. Built per rpc: the
 * worker's MCP server is per session, and the bridge routes each call to the
 * context that owns that session.
 *
 * `allowWrites` is stated by every caller rather than defaulted: it is true only
 * where an approval card gates each write (the Claude path), and a caller that
 * forgot to think about it must not get the writes for free.
 */
export function createMcpDispatcher(
  ctx: UserContext,
  session: McpToolSession | undefined,
  opts: { allowWrites: boolean },
): McpToolDispatcher {
  /** Resolve a `workflow` argument to something writable, or the error to return. */
  const owned = (ref: string): { workflow: WorkflowDef } | { error: string } => {
    const result = commands.resolveWorkflowRef(ctx, ref);
    return result.ok ? { workflow: result.workflow } : { error: refError(ref, result) };
  };

  return async (toolName, args) => {
    // Refused here as well as left out of the read-only manifest: a client can
    // call a tool it was never listed, and this is the side that decides.
    const spec = SPECS.get(toolName);
    if (spec && !spec.readOnly && !opts.allowWrites) {
      return fail(
        `${toolName} is not available from this session — Lines tools are read-only here. ` +
          'Tell the user what to change and they can do it in Lines.',
      );
    }
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
        // Formatted here, not in the view: that view also answers the browser,
        // which needs the numeric timestamps.
        return ok(versions.map(commands.stepView));
      }

      case 'propose_ui': {
        // Nothing is stored: the transcript's tool-call event is the proposal, and
        // the card renders it from the call's input. This checks the shape, then
        // reports the pick. On the Claude path (allowWrites — the one with cards)
        // the always-ask card has already been answered and resolvePermission put
        // the answer on the input; any `answer` the agent wrote itself was
        // replaced there. Codex has no card, so it never reads one.
        const checked = checkProposal(args);
        if ('error' in checked) return fail(checked.error);
        const answer = opts.allowWrites ? proposalAnswers(args, args.answer) : undefined;
        const text = answer
          ? proposalAnswerText(str(args.title).trim(), answer)
          : `Shown ${checked.labels.length} version${checked.labels.length === 1 ? '' : 's'} (${checked.labels.join(', ')}) to the user. ` +
            'Do not implement until they accept one or give feedback.';
        return { content: [{ type: 'text', text }] };
      }

      case 'list_mcp_connections': {
        const connections = ctx.mcp.list();
        // The status reading this session already has: never warmed from here, so
        // a read cannot spawn a CLI child for a session that is not running one.
        const statuses = session ? await ctx.sessions.mcpServerStatus(session.sessionId) : [];
        const byName = new Map(statuses.map((s) => [s.name, s] as const));
        return ok({
          connections: connections.map((c) => connectionView(c, byName.get(c.name))),
          // Said explicitly so a missing `status` is not read as "disconnected".
          statusKnown: session !== undefined,
        });
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
        return ok({ saved: true, step: commands.stepView(saved) });
      }

      case 'delete_step': {
        const stepId = str(args.stepId);
        if (!ctx.workflows.listSteps().some((s) => s.id === stepId)) {
          return fail(`You have no step ${stepId}.`);
        }
        commands.deleteStep(ctx, stepId);
        return ok({ deleted: true, stepId });
      }

      // ---- MCP connections ----
      //
      // Reached only after the user approved the card (every non-readOnly Lines
      // tool always raises one — see handlePreToolUse/handleCanUseTool), so the
      // checks here are about what Lines will accept at all, not about consent.
      case 'add_mcp_connection': {
        const transport = str(args.transport);
        // Refused before the shared validator, and phrased as a rule rather than
        // a validation error: a local command proposed from something the agent
        // read is arbitrary code execution, and a credential passed here would be
        // written into the transcript and the synced connection list.
        if (transport === 'stdio') {
          return fail(
            'Lines does not accept a stdio (local command) MCP server from an agent proposal — that is arbitrary code execution. Tell the user to add it themselves in Settings → Connections.',
          );
        }
        if (transport !== 'http' && transport !== 'sse') {
          return fail("`transport` must be 'http' or 'sse'.");
        }
        const refused = REFUSED_PROPOSAL_ARGS.filter((key) => args[key] !== undefined);
        if (refused.length) {
          return fail(
            `Lines does not accept ${refused.join(', ')} from an agent proposal — OAuth only, no credential values. If this server needs a header or a token, tell the user to add it in Settings → Connections.`,
          );
        }
        const source = str(args.source).trim();
        if (!source) {
          return fail('`source` is required: pass the documentation URL you read this endpoint from.');
        }
        // The same gate the Settings form and the wire handler use, so the
        // reserved-name, duplicate-name and URL rules cannot diverge here.
        const added = ctx.mcp.add({ name: str(args.name), transport, url: str(args.url), enabled: true });
        if (!added.ok) return fail(connectionRefusal(added.reason));
        // onChange has already broadcast the list, pushed it to storage and
        // pushed the server onto every live query (see buildUserContext), so the
        // tools are live in this turn — nothing restarts.
        return ok({
          added: true,
          connection: connectionView(added.connection, undefined),
          next: `Call authorize_mcp_connection with name "${added.connection.name}" to sign the user in, then use its tools.`,
        });
      }

      case 'authorize_mcp_connection': {
        // A caller that cannot name a session declines rather than guesses. Codex
        // was that caller — it names one MCP server for the whole CODEX_HOME, so a
        // call cannot say which thread made it — and no longer reaches this at
        // all (a write, refused above). Either way the user has a working route,
        // and the message names it.
        if (!session) {
          return fail(
            'This call did not arrive with a session to authorize from — ask the user to ' +
              'authorize it in Settings → Connections.',
          );
        }
        const name = str(args.name).trim().toLowerCase();
        const connection = ctx.mcp.list().find((c) => c.name === name);
        if (!connection) {
          return fail(`No connection named "${name}". Read list_mcp_connections first.`);
        }
        if (connection.transport === 'stdio') {
          return fail(
            `"${name}" is a local (stdio) server, which takes its credentials from its own environment — there is nothing to authorize.`,
          );
        }
        if (!connection.enabled) {
          return fail(`"${name}" is switched off. Ask the user to enable it in Settings → Connections.`);
        }
        const outcome = await session.authorize(name);
        if ('error' in outcome) return fail(outcome.error);
        if ('pending' in outcome) {
          return ok({
            authorized: false,
            pending: true,
            message: `Still waiting on the ${name} sign-in. Ask the user to finish it in the tab that opened, then call authorize_mcp_connection again.`,
          });
        }
        return ok({
          authorized: true,
          ...(outcome.alreadyAuthorized ? { alreadyAuthorized: true } : {}),
          message: `${name} is authorized on this machine. Its tools are usable now.`,
        });
      }

      default:
        return fail(`Unknown tool "${toolName}".`);
    }
  };
}
