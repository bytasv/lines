/**
 * Browser <-> bridge wire contract, distinct from the bridge <-> worker
 * PROTOCOL_VERSION in server/src/workerProtocol.ts.
 *
 * These two halves ship together today, so nothing *enforces* this yet — but skew
 * is no longer silent either: the client compares this constant against the
 * bridge's `hello` and says so in a header pill (`protocolSkew`, SkewBanner).
 * It exists because the hosted web app ships independently of every installed
 * bridge, and a version the client can read is the prerequisite for degrading
 * gracefully instead of throwing on a message shape it does not know.
 *
 * When to bump:
 *  - a new message type, or a new required field: bump.
 *  - **removing or renaming a field a client renders: bump.** This is the case
 *    that was missed. Dropping `SessionMeta.caveman` was wire-compatible in the
 *    types and still crashed every browser holding an older bundle, which read
 *    `session.caveman.enabled` on a meta that no longer had the field.
 *  - adding an *optional* field: free, no bump. An older client ignores it.
 */
/**
 * 2: a bridge at this version understands the `grant` field on the relay's `open`
 * frame and enforces `MESSAGE_AUTHZ`. The relay refuses to wire a guest to
 * anything older (COLLAB_MIN_PROTOCOL), because a bridge that silently drops the
 * grant would serve that guest as if they owned the machine. A `>=` gate, so
 * every version above still clears it.
 *
 * 3: `SessionMeta.caveman` is gone (a client older than this renders it and
 * throws), along with the rest of the removals since 2.
 */
export const APP_PROTOCOL_VERSION = 3;

/**
 * Workspace reads the browser makes over the WebSocket rather than plain HTTP.
 *
 * These were `/file`, `/tree`, `/find`, `/docs` and `/attachments/*` GETs with the
 * Clerk token in the query string. Moving them onto the already-authenticated
 * socket removes that token from URLs (and so from logs and browser history),
 * and means a connection reached through a relay needs no HTTP surface at all.
 */
export type FileRequestKind =
  | 'file'
  | 'tree'
  | 'find'
  | 'docs'
  | 'attachment'
  | 'syncLog'
  | 'sessionDiff'
  | 'sessionDiffFile';

export interface FileRequestParams {
  /** file/tree/docs: exactly one. find: one per project root.
   *  sessionDiffFile: the repo root the file lives in. */
  paths?: string[];
  /** find only. */
  q?: string;
  limit?: number;
  /** find: also match gitignored files (`.env`, build output). Defaults to false —
   *  the `@mention` menu never asks for them, only the file palette's toggle does. */
  includeIgnored?: boolean;
  /** attachment: path relative to the user's attachments root.
   *  sessionDiffFile: path relative to `paths[0]`. */
  rel?: string;
  /** sessionDiff / sessionDiffFile: which session's changes to read. */
  sessionId?: string;
}

export type FileChangeStatus = 'A' | 'M' | 'D';

/** One changed file in a session's review diff. */
export interface FileChange {
  /** Path relative to its repo root. */
  rel: string;
  status: FileChangeStatus;
  added: number;
  removed: number;
  /** Another session was live in the same work tree while this change landed, so
   *  it is reported rather than claimed. */
  ambiguous?: boolean;
}

/** One commit unit's section of a session review diff. */
export interface SessionDiffRepo {
  /** Absolute work-tree root (`git rev-parse --show-toplevel`). */
  repo: string;
  branch: string | null;
  /**
   * Where the diff's floor came from:
   * - 'session'   — the snapshot taken when the session was created.
   * - 'workflow'  — a workflow's own snapshot, for a session that predates the
   *                 session-level one.
   * - 'synthetic' — none recorded, so this is the repo's whole uncommitted state.
   * - 'stale'     — one was recorded but `git gc` pruned it; fell back to HEAD.
   */
  baseline: 'session' | 'workflow' | 'synthetic' | 'stale';
  /** Changed by this session, as far as its turn windows and tool calls know. */
  attributed: FileChange[];
  /** The rest of the repo's uncommitted state — in a shared checkout this may be
   *  another session's work, or the user's own. */
  other: FileChange[];
  /** Untracked files beyond the per-repo listing cap, left out of `other`. */
  untrackedOmitted?: number;
}

export interface SessionDiffResponse {
  repos: SessionDiffRepo[];
  /** Session roots that aren't inside a work tree — never a commit unit. */
  orphans: string[];
}

export interface SessionDiffFileResponse {
  before: string;
  after: string;
}

/** Bodies mirror the old JSON responses; `attachment` returns base64 bytes. */
export interface AttachmentBody {
  data: string;
  mediaType: string;
}

/**
 * Desktop auto-update, surfaced in the browser because that is where the user is
 * looking — not the tray. `restartBlocked` is the bridge's contribution: a
 * restart kills in-flight turns, so it is refused while any session is active.
 */
export interface UpdateStatus {
  state: 'idle' | 'available' | 'downloading' | 'ready' | 'error';
  /** Version being offered, when one is. */
  version?: string;
  /** 0..100 while downloading. */
  progress?: number;
  message?: string;
  restartBlocked?: boolean;
}

/** Who the client is actually talking to, sent on `hello`. */
export interface BridgeInfo {
  /** Package version of the running bridge — for display and support. */
  version: string;
  /** Contract version; compare against the client's own APP_PROTOCOL_VERSION. */
  appProtocol: number;
}

/**
 * 'auto' is UI-level: the SDK runs in acceptEdits underneath while the bridge
 * server auto-approves tool calls its guard considers safe and prompts only
 * for dangerous ones (a local replica of the CLI's auto mode).
 */
export type PermissionMode = 'default' | 'auto' | 'plan' | 'acceptEdits' | 'bypassPermissions';

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'done'
  | 'waiting-permission'
  | 'waiting-approval'
  | 'error';

/** A live SDK turn is running and can be stopped via `interrupt`. */
export const isSessionInterruptible = (s: SessionStatus) =>
  s === 'running' || s === 'waiting-permission';

/**
 * The session is not free to take a new prompt straight through — it is either
 * interruptible or paused awaiting a workflow-step approval. Sends should be
 * staged/queued rather than injected.
 */
export const isSessionActive = (s: SessionStatus) =>
  isSessionInterruptible(s) || s === 'waiting-approval';

/**
 * The error text of an SDK `result` message. A success result carries the assistant's
 * final text in `result`; SDKResultError carries no `result` at all — only
 * `errors: string[]` — so reading `result` alone loses the reason entirely.
 */
export function resultErrorText(msg: { result?: unknown; errors?: unknown }): string {
  if (typeof msg.result === 'string' && msg.result) return msg.result;
  if (Array.isArray(msg.errors)) {
    return msg.errors.filter((e): e is string => typeof e === 'string' && e !== '').join('\n');
  }
  return '';
}

/**
 * Whether a `result` ended a turn the user stopped. `stopped` is not an SDK field:
 * the bridge stamps it onto the raw payload before persisting, because the SDK
 * reports an interrupt as an ordinary error result and only the bridge knows the
 * user asked for it. Additive — absent on records written before this existed, and
 * on every result the bridge did not stamp.
 */
export const isStoppedResult = (r: { stopped?: unknown }): boolean => r.stopped === true;

/** How an attachment is presented to the model. */
export type AttachmentKind = 'image' | 'document' | 'text';

/** An attachment sent with a prompt (client -> server). `data` is raw base64 (no data: URI prefix). */
export interface PromptAttachment {
  name: string;
  mediaType: string;
  data: string;
}

/** A persisted attachment reference, stored in the user transcript event and served over HTTP. */
export interface Attachment {
  name: string;
  mediaType: string;
  kind: AttachmentKind;
  /** Server route to fetch the stored file, e.g. /attachments/<sessionId>/<file>. */
  url: string;
}

/**
 * A user @mention of a project entity (feature, file, …), carried alongside a
 * prompt as display-only metadata. The agent-facing expansion is baked into the
 * prompt text before send, so `mentions` never drives what the model sees — only
 * how the reference renders as a badge in the transcript. `kind` is an open set.
 */
export interface PromptMention {
  kind: string; // 'feature' | 'file' | future kinds
  id: string; // feature id, or repo-relative file path
  label: string; // chip text
  detail?: string; // feature purpose / secondary line
}

/**
 * A mention candidate as offered in the autocomplete popover. Extends the
 * display-only {@link PromptMention} with the agent-facing `expansion` text,
 * which the composer bakes into the prompt on send (never sent as sidecar data).
 */
export interface MentionCandidate extends PromptMention {
  expansion: string;
}

/**
 * A committed mention pinned to the `[start, end)` span of the prompt text it
 * renders as an inline pill for — the span covers the display token
 * (`@Model selector`), excluding the trailing space. The text stays
 * authoritative; ranges are a derived view the composer realigns on every edit.
 * Sorted and non-overlapping.
 */
export interface MentionRange extends MentionCandidate {
  start: number;
  end: number;
}

/**
 * Prompt text plus the mention ranges painted over it — the composer's draft
 * state. Lives here rather than in the web app because a queued prompt persists
 * one (see {@link QueuedPrompt.draft}), so it crosses the wire.
 */
export interface MentionValue {
  text: string;
  ranges: MentionRange[];
}

/** A prompt sent while the session was busy; held server-side and flushed after the current turn. */
export interface QueuedPrompt {
  id: string;
  ts: number;
  text: string;
  /** Staged attachment refs; the server re-reads the files back to base64 at flush time. */
  attachments?: Attachment[];
  /** Display-only @mention badges; the expansion is already baked into `text`. */
  mentions?: PromptMention[];
  /**
   * Who wrote it. Load-bearing for a guest's `promptNeedsApproval` prompt: the
   * owner releases it, but the transcript must credit the person who typed it.
   */
  actor?: Actor;
  /**
   * The composer's pre-expansion draft, so the item can be re-edited with its
   * pills intact — `text` is already expanded, and re-seeding an editor from it
   * would show the user the expansion block and append a second one on save.
   * Written only when there are mentions: without them `text` *is* the draft,
   * and `queued` rides the synced session blob.
   */
  draft?: MentionValue;
  /** When the item was last rewritten in place. Absent = never edited. */
  editedAt?: number;
  /**
   * Who rewrote it, when that is not the author. An owner reviewing a guest's
   * pending-approval prompt may edit it, and the released prompt still runs
   * attributed to the guest — so the rewrite has to be visible, not silent.
   */
  editedBy?: Actor;
}

/** The runnable/editable fields of a step. */
export interface StepContent {
  name: string;
  promptTemplate: string;
  model: string;
  permissionMode: PermissionMode;
  autoAdvance: boolean;
  /**
   * When true, the step runs in a fresh Claude CLI session instead of inheriting
   * the running conversation. It is seeded with a compact hand-off (the previous
   * step's final output via `{previous}` and the working-tree `git diff` via
   * `{diff}`) rather than the full accumulated transcript. Default false = inherit.
   */
  freshStart: boolean;
  /**
   * Optional label under which this step's final output is stored in the workflow
   * run, so any later step can pull it via `{outputs.<name>}` — not just the
   * immediately previous step. Empty/undefined = the output isn't published.
   */
  outputName?: string;
}

/**
 * A standalone, versioned, shareable step. The author's editable "head" lives in
 * the step store; every version is immutable once written, so a workflow pinned
 * to an older version keeps running that exact content even after a republish.
 */
export interface StepDef extends StepContent {
  id: string;
  ownerId: string;
  ownerName?: string;
  version: number;
  published: boolean;
  updatedAt?: number;
  /**
   * ms epoch of when this step *id* was first created — identical across every
   * version of the same step, and only ever moved earlier. The mint time of one
   * particular version is that immutable row's `updatedAt`.
   */
  createdAt?: number;
}

/** A consumer's pinned reference to another author's published step version. */
export interface StepRef {
  kind: 'ref';
  stepId: string;
  ownerId: string;
  ownerName?: string;
  version: number;
}

/**
 * An inline step: private content embedded in the workflow. Optionally carries
 * its own published identity once the owner publishes it to the library — the
 * owner keeps editing this inline head; consumers get a {@link StepRef} instead.
 */
export interface InlineStep extends StepContent {
  kind?: 'inline';
  stepId?: string;
  ownerId?: string;
  ownerName?: string;
  version?: number;
  published?: boolean;
}

export type WorkflowStep = InlineStep | StepRef;

export function isStepRef(s: WorkflowStep): s is StepRef {
  return (s as StepRef).kind === 'ref';
}

/** Resolve a workflow step to its runnable content via a version lookup for refs. */
export function resolveStepContent(
  step: WorkflowStep,
  lookup: (ownerId: string, stepId: string, version: number) => StepContent | undefined,
): StepContent | undefined {
  return isStepRef(step) ? lookup(step.ownerId, step.stepId, step.version) : step;
}

export interface WorkflowDef {
  id: string;
  name: string;
  steps: WorkflowStep[];
  /** ms epoch of the last save — last-write-wins key for cross-instance sync. */
  updatedAt?: number;
  /** ms epoch of the first save. Never restamped, and only ever moved earlier. */
  createdAt?: number;
  /** Owner opted in to sharing this workflow with every other user on the instance. */
  published?: boolean;
  /** Clerk userId of the owner — authoritative, stamped server-side on save. */
  ownerId?: string;
  /** Display label for the owner (name→email), cosmetic, supplied by the client. */
  ownerName?: string;
}

// ---------------------------------------------------------------------------
// Recipes — publishable, versioned prompt documents
// ---------------------------------------------------------------------------

/** A saved bundle's member. No `version` — bundles compose identities, not snapshots. */
export interface RecipeRef {
  ownerId: string;
  recipeId: string;
}

/** The editable/publishable fields of a recipe (leaf prompt or bundle of recipes). */
export interface RecipeContent {
  title: string;
  /** One-paragraph pitch shown in the browse list. */
  description: string;
  /** Normalized, deduped, <= RECIPE_TAG_MAX; order carries no meaning, may be empty. */
  tags: string[];
  /** Public R2 URLs, in display order. */
  images: string[];
  /** Leaf recipe: the prompt injected verbatim. Empty on a bundle. */
  prompt: string;
  /** Bundle: ordered members, 2..RECIPE_BUNDLE_MAX. Absent/empty on a leaf. */
  members?: RecipeRef[];
}

/**
 * Exactly one of `prompt` / `members` is populated — enforced in
 * `RecipeEngine.saveRecipe`, which is the only write path that can be trusted.
 */
export function isBundle(r: Pick<RecipeContent, 'members'>): boolean {
  return (r.members?.length ?? 0) > 0;
}

/**
 * A published recipe head or one of its immutable versions. Carries no
 * `model`/`permissionMode` — a recipe is a prompt, not a step; the spawned
 * session uses the runner's own defaults. The run counter deliberately lives
 * outside this shape (see `recipeStats`) so an author's stale push can't
 * clobber it.
 */
export interface RecipeDef extends RecipeContent {
  id: string;
  ownerId: string;
  ownerName?: string;
  version: number;
  published: boolean;
  updatedAt?: number;
}

export const RECIPE_IMAGE_MAX_COUNT = 4;
/** Decoded bytes, checked bridge- and storage-side. */
export const RECIPE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const RECIPE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const RECIPE_TAG_MAX = 6;
export const RECIPE_TAG_MAX_LEN = 24;
/** Recipes combinable into one run — also the post-expansion ceiling on a bundle. */
export const RECIPE_BUNDLE_MAX = 8;

/**
 * Canonical tag form: lowercase, trimmed, inner whitespace to '-', anything
 * outside [a-z0-9-_.] stripped, repeated '-' collapsed, truncated.
 *
 * Shared (not server-only) so the editor can preview the exact string the engine
 * will store — otherwise a tag silently changes shape on save. The server still
 * re-normalizes every save: this is a convenience, never the enforcement point.
 */
export function normalizeRecipeTag(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_.]/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, RECIPE_TAG_MAX_LEN)
    // After the truncation, not before: a cut that lands on a '-' would otherwise
    // store a tag that re-normalizes to a different string, and every later save
    // of that same tag would look like a content change and bump a version.
    .replace(/^-+|-+$/g, '');
}

export type WorkflowStepStatus = 'pending' | 'running' | 'waiting-approval' | 'done';

export interface WorkflowState {
  workflowId: string;
  stepIndex: number;
  stepStatuses: WorkflowStepStatus[];
  /** The user's task description, captured from the first prompt; substituted into step templates as {task}. */
  task?: string;
  started: boolean;
  /** Advance to the next step once the current turn ends. Two origins: `true` from
   *  a plan approved mid-step, 'interrupted' from a force-advance ("mark as
   *  completed") of a still-running step. A plain Stop never sets it. */
  advanceOnComplete?: boolean | 'interrupted';
  /** The step index `advanceOnComplete` was flagged for. A settle for any other
   *  index ignores the flag, so an abandoned turn's late result can never advance
   *  (or park) a later step. Absent on metas persisted by an older build. */
  advanceOnCompleteStep?: number;
  /** An advance is in flight on this bridge: the finished step is 'done' and its
   *  output is being consolidated, but the next step hasn't started. Drives the
   *  Approve button's loader. In-flight only — never trusted across a bridge
   *  restart or an instance hand-off. */
  advancing?: boolean;
  /** Current step's configured permission mode, snapshotted at step start.
   *  Distinguishes a workflow-mandated 'plan' from a manual mid-step override. */
  stepPermissionMode?: PermissionMode;
  /** Named step outputs captured as each step completes, keyed by its `outputName`.
   *  Referenced from later step templates via `{outputs.<name>}`. */
  outputs?: Record<string, string>;
  /** Per-step accumulated cost in USD, indexed by step position. Summed across
   *  every turn a step runs (retries included); shown in the stepper. */
  stepCostsUsd?: number[];
  /** Per-step accumulated tokens (input + output + cache), indexed by step
   *  position. Summed across every turn a step runs (retries included). */
  stepTokens?: number[];
  /** Per-step accumulated active-turn duration in ms, indexed by step position.
   *  Summed across every turn a step runs (retries included); excludes idle wait. */
  stepDurationsMs?: number[];
  /** Working-tree snapshot taken when the workflow starts, one per commit unit
   *  (`git rev-parse --show-toplevel`), so a fresh step's {diff} shows only what
   *  the workflow changed in each repo, not pre-existing dirty state. */
  diffBaselines?: { repo: string; ref: string; untracked: string[] }[];
  /** @deprecated pre-multi-root single baseline. Never written any more, still
   *  read so a workflow already in flight across the deploy keeps a correct diff
   *  instead of silently falling back to HEAD. */
  diffBaseline?: { ref: string; untracked: string[] };
  /** Consolidated final output of the last-completed step; consumed as {previous}
   *  by the next fresh-start step. Falls back to lastAssistantText when absent. */
  lastStepOutput?: string;
  /** Set when the current step parked because it *failed* rather than finishing, so
   *  a one-click Retry knows what to re-run. 'turn' = its turn failed, so Retry
   *  re-sends that prompt as a follow-up; 'pre-run' = the step never got a prompt
   *  (unresolved ref, missing `{outputs.*}`), so Retry re-renders it from scratch.
   *  Cleared the moment the step runs again or the workflow moves on. */
  stepFailure?: 'pre-run' | 'turn';
}

/**
 * Prompt composition of the most recent API call in the last turn — context
 * occupancy, NOT cumulative spend. Sourced from the final `assistant` message,
 * whose usage describes a single API call; a result's usage is turn-cumulative.
 */
export interface ContextUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  /** SDK-reported prompt total when it disagrees with the component sum. */
  reportedTotal?: number;
  /** Model that produced this reading; the window limit is keyed off it. */
  model: string;
  at: number;
}

/**
 * One row of the CLI's `/context` breakdown. Deferred rows (tools behind tool
 * search) are EXCLUDED from `totalTokens` and from free space — never fold them
 * into a derived total, or the ring double-counts.
 */
export interface ContextCategory {
  name: string;
  tokens: number;
  deferred?: boolean;
}

/**
 * Small PERSISTED projection of the SDK's context breakdown, stored on
 * SessionMeta so the chip renders on load and after a restart with no live
 * query. Keep it under ~1 KB: every upsert writes it to disk and pushes it
 * through the storage sync.
 */
export interface ContextSummary {
  at: number;
  model: string;
  /** SDK totalTokens — non-deferred categories only. */
  totalTokens: number;
  /** The window the CLI budgets against; the ring's denominator. */
  maxTokens: number;
  /** Model window before the CLI's reserves, when it differs from maxTokens. */
  rawMaxTokens?: number;
  percentage: number;
  /** Non-zero rows with 'Free space' dropped (it is derived), capped. */
  categories: ContextCategory[];
  autoCompactThreshold?: number;
  isAutoCompactEnabled?: boolean;
}

/** EPHEMERAL full breakdown — fetched on demand, never persisted or synced. */
export interface ContextBreakdown extends ContextSummary {
  /** MCP tools regrouped by server, so the UI expands server -> tools. */
  mcpServers: {
    serverName: string;
    tokens: number;
    toolCount: number;
    tools: { name: string; tokens: number; loaded?: boolean }[];
  }[];
  memoryFiles: { path: string; type: string; tokens: number }[];
  agents: { agentType: string; source: string; tokens: number }[];
  systemTools: { name: string; tokens: number }[];
  systemPromptSections: { name: string; tokens: number }[];
  /** Built-in tools deferred behind tool search. */
  deferredTools: { name: string; tokens: number; loaded?: boolean }[];
  skills?: { total: number; included: number; tokens: number; items: { name: string; source: string; tokens: number }[] };
  slashCommands?: { total: number; included: number; tokens: number };
  messages?: {
    toolCalls: number;
    toolResults: number;
    attachments: number;
    assistant: number;
    user: number;
    other: number;
  };
}

/**
 * A compaction of the CLI conversation — the model summarizes the transcript so
 * far and the summary replaces it. Either the user asked for it ('manual', via
 * the Compact now button) or the CLI's own auto-compaction fired ('auto').
 *
 * `postTokens` is optional: the SDK's compact_metadata may omit it, in which case
 * the next turn's reading is the only post-compaction number we get.
 */
export interface ContextCompactRecord {
  at: number;
  trigger: 'manual' | 'auto';
  preTokens?: number;
  postTokens?: number;
  /** false = the SDK reported the compaction failed (see contextCompactBlock's
   *  `unsupported`), which disables the manual button for this CLI conversation. */
  ok: boolean;
  /** SDK-reported failure text (compact_error), capped. Only set when ok:false. */
  error?: string;
}

/** Transcript-event payload for a compaction (kind: 'context-compact'). */
export interface ContextCompactData {
  /** 'requested' opens a span, 'done' closes it. An auto-compaction only emits 'done'. */
  phase: 'requested' | 'done';
  trigger?: 'manual' | 'auto';
  preTokens?: number;
  postTokens?: number;
  ok?: boolean;
  error?: string;
}

/** Chat-turn spend for one model id. Internal helper queries are not counted. */
export interface ModelSpend {
  costUsd: number;
  tokens: number;
  turns: number;
}

/** Per-model spend rows, keyed by resolved model id. See `./usageByModel.ts`. */
export type ModelSpendMap = Record<string, ModelSpend>;

/**
 * Which named failure a red banner is describing, so the UI can offer more than a
 * bare Retry. `'auth'` is the app being signed out; the rest are the API refusing
 * the turn itself (see `server/src/turnFailure.ts`). Additive — a client that only
 * understands `'auth'` still behaves correctly for the others.
 */
export type SessionErrorKind = 'auth' | 'filtered' | 'context' | 'invalid' | 'overloaded';

/**
 * One live background task (a backgrounded subagent or Bash command), taken from
 * the SDK's `background_tasks_changed` level payload. The payload names every
 * live task, so this is a record rather than a bare count — the two can't drift.
 */
export interface BackgroundTaskInfo {
  /** SDK `task_id`. */
  id: string;
  /** SDK `task_type` (e.g. 'subagent', 'bash'). */
  type: string;
  description: string;
}

export interface SessionMeta {
  id: string;
  name: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  status: SessionStatus;
  createdAt: number;
  /** True until the name is either auto-generated from the first prompt or renamed by the user. */
  nameAuto?: boolean;
  claudeSessionId?: string;
  /**
   * Who sent the prompt driving the current turn. One field on the already-synced
   * blob, changing once per turn — enough for the sidebar to say "your colleague
   * is running this" without a second channel.
   */
  turnActor?: Actor;
  workflow?: WorkflowState;
  lastCostUsd?: number;
  totalCostUsd?: number;
  /** `totalCostUsd` split by the model each turn ran on. Additive and never
   *  backfilled — a session shows nothing here until its next turn settles. */
  costByModel?: ModelSpendMap;
  /** Tokens spent by the most recent turn (input + output + cache), matching
   *  the `totalTokens` composition. */
  lastTokens?: number;
  /** Cumulative tokens spent across the session (input + output + cache). */
  totalTokens?: number;
  /** Context occupancy after the most recent turn; distinct from the cumulative
   *  spend above. See ContextUsage. Fallback for when the SDK breakdown below
   *  is unavailable. */
  contextUsage?: ContextUsage;
  /** `/context` breakdown summary from the last successful control request —
   *  the authoritative occupancy reading. See preferContextSummary. */
  contextSummary?: ContextSummary;
  /** Last compaction of this session's CLI conversation, whoever triggered it.
   *  Self-corrects the occupancy reading (see effectiveContextTokens) and, when
   *  `ok: false`, records that compaction isn't available here. */
  contextCompact?: ContextCompactRecord;
  /** ms epoch the CLI conversation was discarded (fresh-start workflow step).
   *  Any reading older than this describes a conversation that no longer exists,
   *  so the UI marks it stale until the next turn reports. */
  contextResetAt?: number;
  /** Active-turn duration of the most recent turn in ms (SDK result duration_ms). */
  lastDurationMs?: number;
  /** Cumulative active-turn duration across the session in ms; excludes idle wait. */
  totalDurationMs?: number;
  errorMessage?: string;
  /** Set alongside `errorMessage` when the failure has a named next action — a
   *  sign-in (`'auth'`, which drives the Sign in button and is never set in
   *  ambient-token mode, where there is no login flow to offer), or one of the
   *  API-side refusals the banner spells out. Unset when the failure is unclassified
   *  and the raw text stands. Same lifetime as `errorMessage` (setStatus clears both). */
  errorKind?: SessionErrorKind;
  /** Tool that triggered the current `waiting-permission` pause (e.g. `AskUserQuestion`,
   *  `ExitPlanMode`), so the UI can vary the badge label/color. Cleared on any other status. */
  pendingPermissionTool?: string;
  /** Archived sessions move to a separate section and are hidden from the active list. */
  archived?: boolean;
  archivedAt?: number;
  /** Marked done by the user; shows a special indicator and is archived. */
  completed?: boolean;
  /**
   * Who initiated the turn currently in flight — drives workflow advancement.
   * Persisted so a bridge restart mid-turn doesn't misattribute the result.
   */
  turnSource?: 'user' | 'workflow';
  /** ms epoch when the in-flight turn started; cleared when the turn settles. */
  turnStartedAt?: number;
  /** ms epoch of the last upsert — last-write-wins key for cross-instance sync. */
  updatedAt?: number;
  /** Prompts sent while busy, held for FIFO auto-send after each turn completes. */
  queued?: QueuedPrompt[];
  /** Interrupt/error/crash suspended auto-flush; the next user send resumes it. */
  queuePaused?: boolean;
  /** ms epoch when a crash/restart killed an in-flight turn; cleared by the next prompt. */
  interruptedAt?: number;
  /**
   * Background tasks (subagents, Bash) still running inside this session's CLI
   * process after its turn settled. Live-only: per-process, never restored from
   * disk — a bridge restart starts empty and repopulates from the worker's
   * `hello` (see LiveSessionInfo.backgroundTasks) or the next membership change.
   *
   * Deliberately not folded into `status`: the turn lifecycle (queue flush,
   * workflow advance, turn-complete accounting) all keys off the turn settling,
   * and this describes work outside it.
   */
  backgroundTasks?: BackgroundTaskInfo[];
  /**
   * Working-tree snapshot taken when the session was created, one per commit unit
   * (`git rev-parse --show-toplevel`) — the floor the session review diff is taken
   * against, so it shows this session's work rather than every uncommitted change
   * in the repo. Same non-destructive `git stash create` snapshot the workflow
   * path takes; a few hundred bytes per repo on this synced blob.
   */
  diffBaselines?: { repo: string; ref: string; untracked: string[] }[];
  /** ms epoch the baselines above were captured. */
  diffBaselineAt?: number;
}

export interface ModelOption {
  id: string;
  label: string;
  /** One-line summary shown under the label in model dropdowns. */
  description?: string;
  /** Max context window in tokens; omitted when unknown (chip hides its ring). */
  contextWindow?: number;
}

/** A single entry in a session transcript, persisted as JSONL and streamed live. */
export interface TranscriptEvent {
  /** Monotonic per-session sequence number. */
  seq: number;
  ts: number;
  /**
   * kind:
   * - 'user'      : user prompt text
   * - 'interject' : a queued prompt released into the *running* turn ("Send now").
   *                 Deliberately its own kind and not a flag on 'user': every turn
   *                 scan treats a 'user' event as "a turn starts here", and an
   *                 interjection starts nothing.
   * - 'sdk'       : raw SDK message (assistant / system / result / stream_event ...),
   *                 carrying one bridge-added field: `stopped` on a result the user
   *                 stopped (see isStoppedResult). Nothing else here is ours.
   * - 'file-snapshot': pre-edit file content captured for a tool_use (for diffs)
   * - 'permission': permission request / resolution
   * - 'workflow'  : workflow step transition marker
   * - 'turn-summary': one-line summary of a completed turn's tool activity
   * - 'context-compact': context compaction requested / finished
   * - 'files-changed': paths a completed turn changed on disk
   */
  kind:
    | 'user'
    | 'interject'
    | 'sdk'
    | 'file-snapshot'
    | 'permission'
    | 'workflow'
    | 'turn-summary'
    | 'context-compact'
    | 'files-changed';
  data: unknown;
}

/**
 * A queued prompt delivered into the turn that was already running, rather than
 * waiting for it to settle.
 *
 * No `source` field, unlike a 'user' event: an interjection is always
 * human-authored. Workflows and recovery re-prompt, they never interject.
 */
export interface InterjectData {
  text: string;
  /** Display-only @mention badges; the expansion is already baked into `text`. */
  mentions?: PromptMention[];
  /** The item's author, not whoever pressed Send now (see maybeFlush's rule). */
  actor?: Actor;
}

export interface TurnSummaryData {
  /** seq of the sdk 'result' event this summarizes. */
  resultSeq: number;
  summary: string;
}

/**
 * What one turn changed on disk, measured by bracketing the turn with two git
 * snapshots rather than by reading its tool calls — so a write made through the
 * shell, a script, or an MCP tool is recorded just the same.
 *
 * A transcript event, deliberately not a field on `SessionMeta`: that blob is
 * synced, and per-turn path lists would grow it without bound. Transcript events
 * are already per-session, persisted, and dropped with the session.
 */
export interface FilesChangedData {
  /** seq of the sdk 'result' event that closed this window. */
  resultSeq: number;
  repos: {
    /** Absolute work-tree root. */
    repo: string;
    /** Paths relative to `repo`. */
    rels: string[];
    /** Another session was live in this work tree during the window, so these
     *  paths are reported as unclear rather than attributed. */
    ambiguous?: boolean;
  }[];
}

export interface FileSnapshotData {
  toolUseId: string;
  toolName: string;
  filePath: string;
  /** File content before the edit; null if the file did not exist. */
  before: string | null;
}

/**
 * How a permission resolution came about. Recorded so "did a human decide this?"
 * is answerable from the transcript alone — 'user' and 'plan-reply' are the only
 * human gestures; everything else is the server resolving on its own behalf.
 */
export type PermissionResolutionSource =
  | 'user'
  | 'plan-reply'
  | 'auto'
  | 'recovery'
  | 'workflow-advance'
  | 'interrupt-expire'
  | 'stop'
  | 'cancel';

export interface PermissionRequestData {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** 'expired' = the server no longer holds this request (restart/interrupt); re-prompt needed. */
  resolution?: 'allow' | 'deny' | 'expired';
  /**
   * On resolutions: which path produced this answer. Optional — absent on
   * transcripts written before it existed, which every consumer must read as
   * 'user' (the only resolution source that existed for cards the user saw).
   */
  resolvedBy?: PermissionResolutionSource;
  /**
   * Who answered it. Alongside `resolvedBy`, not folded into it: that field is
   * provenance-of-decision (a user, a workflow advance, a recovery sweep), which
   * is a different question from which person clicked. Absent means the host.
   */
  resolvedActor?: Actor;
  /** For AskUserQuestion: question text -> selected label(s) the user chose. */
  answers?: Record<string, string>;
  /**
   * On 'allow' resolutions: the (possibly edited) input the user approved.
   * Recorded so a re-delivered permission request after a bridge restart can
   * be answered from the transcript with the exact approved input.
   */
  updatedInput?: Record<string, unknown>;
  /** True when the auto-mode guard approved this call without asking. */
  auto?: boolean;
  /** Why the auto-mode guard flagged this call for manual review. */
  guardReason?: string;
  /**
   * Set instead of a tool call when an MCP server asked the user for something
   * — in practice an OAuth authorization URL. Carried on the permission card
   * rather than in a mechanism of its own: this needs resolution provenance,
   * dedupe of a second answer and replay after a bridge restart, all of which
   * the card already solves.
   */
  elicitation?: McpElicitation;
  /**
   * Bridge-computed trust assessment of an MCP server the *agent* proposed, so
   * the user approves against a signal rather than a bare URL. Same precedent as
   * `guardReason`: advisory, computed once before the card is raised, and
   * persisted with it so a reload still shows the badge on a pending card.
   *
   * Advisory at every level — no level skips or auto-approves the card.
   */
  vetting?: McpVetting;
  /**
   * On 'deny' resolutions: the reason shown back to the model. Persisted so the
   * card can render it and a re-delivered request after a bridge restart replays
   * the same reason instead of a generic one.
   */
  denyMessage?: string;
}

/**
 * Deny reason that keeps a session in plan mode. Sent by the "Keep planning"
 * button and by a typed composer reply while a plan is up for review, so both
 * gestures read identically to the model.
 */
export const KEEP_PLANNING_MESSAGE =
  'The user is not ready to proceed — stay in plan mode and refine the plan based on their next message.';

/**
 * One note the user attached to a passage of the plan while reviewing it.
 *
 * Anchored by `quote`, never by an offset: the plan markdown is re-rendered on
 * mount and the card re-reads the plan file from disk every time it opens, so a
 * character offset drifts while an excerpt does not.
 */
export interface PlanComment {
  id: string;
  /** The selected passage, verbatim. */
  quote: string;
  /** What the user wants done about it. */
  note: string;
}

const PLAN_COMMENT_QUOTE_MAX = 280;
const PLAN_COMMENT_NOTE_MAX = 2000;
const PLAN_COMMENTS_MAX = 20;

/**
 * Canonical form of a plan-comment list. The single gate every writer runs
 * through — the same role `normalizeAllowEntry` plays for guard entries, and
 * here for the same reason: the server runs it on the untrusted wire payload,
 * and the web client runs the identical rules before sending, so what the user
 * sees on the card is what the model gets.
 *
 * A comment with no note is dropped rather than rejected: an empty note is a
 * selection the user never finished, which carries nothing for the model.
 */
export function normalizePlanComments(raw: unknown): PlanComment[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanComment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const src = item as { id?: unknown; quote?: unknown; note?: unknown };
    const note = typeof src.note === 'string' ? src.note.trim() : '';
    if (!note) continue;
    const quote = typeof src.quote === 'string' ? src.quote.trim() : '';
    out.push({
      id: typeof src.id === 'string' && src.id ? src.id.slice(0, 64) : String(out.length + 1),
      quote: quote.slice(0, PLAN_COMMENT_QUOTE_MAX),
      note: note.slice(0, PLAN_COMMENT_NOTE_MAX),
    });
    if (out.length === PLAN_COMMENTS_MAX) break;
  }
  return out;
}

/**
 * The one place the wording of a commented plan decision lives, so the two
 * buttons on the card and the server that answers them cannot drift.
 *
 * 'refine' reuses the `KEEP_PLANNING_MESSAGE` prefix and the
 * `"The user's message:\n"` marker the typed-composer reply already uses, which
 * is what lets `planReplyText` render the comments back on the resolved card
 * with no client-side special case.
 */
export function formatPlanComments(comments: PlanComment[], mode: 'approve' | 'refine'): string {
  if (comments.length === 0) return '';
  const body = comments
    .map((c, i) => (c.quote ? `${i + 1}. On "${c.quote}": ${c.note}` : `${i + 1}. ${c.note}`))
    .join('\n');
  if (mode === 'refine') {
    return `${KEEP_PLANNING_MESSAGE}\n\nThe user's message:\n${body}`;
  }
  const n = comments.length;
  return (
    `The user approved the plan and left ${n} comment${n === 1 ? '' : 's'} on it. ` +
    `Apply them as you implement — they amend the plan, they do not replace it.\n\n${body}`
  );
}

/** AskUserQuestion tool input shape (subset we render). */
export interface AskUserQuestionInput {
  questions: {
    question: string;
    header: string;
    multiSelect?: boolean;
    options: { label: string; description?: string }[];
  }[];
}

export interface WorkflowMarkerData {
  stepIndex: number;
  stepName: string;
  event: 'started' | 'waiting-approval' | 'approved' | 'interrupted' | 'retried' | 'workflow-done';
  feedback?: string;
  /** Set on a 'waiting-approval' the step was parked with *before* running: the
   *  `{outputs.<name>}` names its template referenced but no earlier step published. */
  missingOutputs?: string[];
  /** Set on a 'waiting-approval' the step parked into because its turn *failed*,
   *  so the divider says so instead of "waiting for your approval". */
  failed?: boolean;
}

/** Response body of the bridge's GET /file endpoint (clickable file-path preview). */
export interface FileContentResponse {
  content: string;
}

/** One entry in a directory listing from the bridge's GET /tree endpoint. */
export interface TreeEntry {
  name: string;
  type: 'file' | 'dir';
  /** Gitignored, so the tree can dim it or hide it. Omitted when it isn't — the
   *  listing always carries the mark and the client decides what to do with it,
   *  which is what makes the "Hide ignored" toggle instant instead of a refetch. */
  ignored?: boolean;
}

/** Response body of the bridge's GET /tree endpoint (project file tree). */
export interface TreeResponse {
  entries: TreeEntry[];
}

/** Response body of the bridge's GET /find endpoint (@mention file-name search). */
export interface FindResponse {
  /** Ranked matches; `rel` is relative to the absolute `root` it was found under. */
  files: { root: string; rel: string }[];
}

// ---------------------------------------------------------------------------
// Documentation reader
// ---------------------------------------------------------------------------

/** One markdown file in the docs bundle; `path` is POSIX and relative to the docs root. */
export interface DocFile {
  path: string;
  content: string;
  bytes: number;
  mtime: number;
}

/** Response body of the bridge's GET /docs endpoint (the whole `docs/**` corpus in one request). */
export interface DocsResponse {
  /** Absolute docs root the paths are relative to. */
  root: string;
  docs: DocFile[];
  /** A limit was hit, so `docs` is a partial view of the tree. */
  truncated: boolean;
}

/** Where a link inside a rendered doc should go. */
export type DocLinkTarget =
  | { kind: 'doc'; rel: string; hash?: string }
  | { kind: 'file'; abs: string }
  | { kind: 'external'; href: string };

/** The feature manifest, relative to the docs root. */
export const DOCS_INDEX_REL = 'codebase/index.json';

/**
 * Collapse `.`, `..` and empty segments in a POSIX-ish relative path. Leading
 * `..` segments survive — that is how {@link resolveDocLink} detects a link that
 * climbs out of the docs root. Hand-rolled because this module is imported by
 * the browser, where `node:path` isn't available.
 */
export function normalizeDocPath(rel: string): string {
  const out: string[] = [];
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** The directory part of a doc-relative path; `''` for a top-level doc. */
export function docDirname(rel: string): string {
  const at = rel.lastIndexOf('/');
  return at === -1 ? '' : rel.slice(0, at);
}

/** A link the reader must hand to the browser: `scheme:`, protocol-relative, `mailto:`. */
export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

/** Join `rel` onto the absolute `base`, never climbing above `floor`. */
function joinAbsClamped(base: string, rel: string, floor: string): string {
  const floorSegs = floor.split('/').filter(Boolean);
  const segs = base.split('/').filter(Boolean);
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      // A link may not walk out of the project it belongs to.
      if (segs.length > floorSegs.length) segs.pop();
      continue;
    }
    segs.push(seg);
  }
  return `/${segs.join('/')}`;
}

/**
 * Decide where a link inside doc `fromRel` points. Markdown targets stay inside
 * the reader even when the file isn't in this corpus — the reader reports that
 * itself, which is friendlier than dropping the user into a 404 preview.
 * Anything that escapes the docs root, or isn't markdown, becomes an absolute
 * source path for the file preview.
 */
export function resolveDocLink(a: {
  href: string;
  fromRel: string;
  docsRoot: string;
  projectRoot: string;
  hasDoc: (rel: string) => boolean;
}): DocLinkTarget {
  const href = a.href.trim();
  if (!href) return { kind: 'doc', rel: a.fromRel };
  if (isExternalHref(href)) return { kind: 'external', href };

  const hashAt = href.indexOf('#');
  const hash = (hashAt === -1 ? '' : href.slice(hashAt + 1)) || undefined;
  let pathPart = hashAt === -1 ? href : href.slice(0, hashAt);
  const queryAt = pathPart.indexOf('?');
  if (queryAt !== -1) pathPart = pathPart.slice(0, queryAt);
  // A bare `#anchor` (or `?q=1`) stays on the current doc.
  if (!pathPart) return hash ? { kind: 'doc', rel: a.fromRel, hash } : { kind: 'doc', rel: a.fromRel };

  if (pathPart.startsWith('/')) {
    const abs = joinAbsClamped('/', pathPart, '');
    const inDocs = abs === a.docsRoot || abs.startsWith(a.docsRoot + '/');
    if (!inDocs) return { kind: 'file', abs };
    pathPart = abs.slice(a.docsRoot.length + 1);
    if (!pathPart) return { kind: 'file', abs };
    return docOrFile(pathPart, hash, a);
  }

  const dir = docDirname(a.fromRel);
  const joined = normalizeDocPath(dir ? `${dir}/${pathPart}` : pathPart);
  if (!joined || joined.startsWith('..')) {
    return { kind: 'file', abs: joinAbsClamped(a.docsRoot, joined, a.projectRoot) };
  }
  return docOrFile(joined, hash, a);
}

/** Shared tail of {@link resolveDocLink} for a path already relative to the docs root. */
function docOrFile(
  rel: string,
  hash: string | undefined,
  a: { docsRoot: string; hasDoc: (rel: string) => boolean },
): DocLinkTarget {
  // Extensionless links are a markdown convention; honour them only when the
  // corpus actually holds the target, so a source path isn't hijacked.
  const isDoc = /\.md$/i.test(rel) || a.hasDoc(rel) || a.hasDoc(`${rel}.md`);
  if (!isDoc) return { kind: 'file', abs: `${a.docsRoot}/${rel}` };
  const target = /\.md$/i.test(rel) || a.hasDoc(rel) ? rel : `${rel}.md`;
  return hash ? { kind: 'doc', rel: target, hash } : { kind: 'doc', rel: target };
}

/** The doc's `# ` heading, falling back to its file name. */
export function docTitle(content: string, rel: string): string {
  const heading = /^#[ \t]+(.+)$/m.exec(content);
  if (heading) return heading[1].trim();
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return base.replace(/\.md$/i, '');
}

/** The `## Purpose` body if the doc has one, else its first paragraph. */
export function docSummary(content: string): string {
  // No `m` flag: the trailing `$` must mean end-of-content, so a Purpose section
  // that runs to the end of the file is still captured.
  const purpose = /\n?##[ \t]+purpose[ \t]*\r?\n([\s\S]*?)(?=\n#{1,6}[ \t]|$)/i.exec(content);
  const body = purpose ? purpose[1] : content.replace(/^#[ \t]+.*$/m, '');
  for (const block of body.split(/\n{2,}/)) {
    const text = block.trim();
    if (!text || text.startsWith('#')) continue;
    return text.replace(/\s+/g, ' ');
  }
  return '';
}

/** One doc that matched a search, with the lines that matched. */
export interface DocSearchHit {
  path: string;
  title: string;
  /** Lower is better: 0 title, 1 heading, 2 body. */
  rank: number;
  matches: { line: number; text: string }[];
}

const SEARCH_SNIPPETS = 3;
const SNIPPET_CHARS = 160;

/** ~{@link SNIPPET_CHARS} characters of `line` centred on the match. */
function snippet(line: string, at: number, len: number): string {
  if (line.length <= SNIPPET_CHARS) return line.trim();
  const start = Math.max(0, at - Math.floor((SNIPPET_CHARS - len) / 2));
  const end = Math.min(line.length, start + SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${line.slice(start, end).trim()}${end < line.length ? '…' : ''}`;
}

/**
 * Case-insensitive substring search across the whole corpus. Title and heading
 * hits outrank body hits, then denser docs win — good enough for a ~30-file
 * corpus searched on every keystroke, with no index to keep in sync.
 */
export function searchDocs(
  docs: readonly Pick<DocFile, 'path' | 'content'>[],
  query: string,
  limit: number,
): DocSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: (DocSearchHit & { count: number })[] = [];
  for (const doc of docs) {
    const title = docTitle(doc.content, doc.path);
    const matches: { line: number; text: string }[] = [];
    let count = 0;
    let headingHit = false;
    doc.content.split('\n').forEach((line, i) => {
      const at = line.toLowerCase().indexOf(q);
      if (at === -1) return;
      count++;
      if (line.startsWith('#')) headingHit = true;
      if (matches.length < SEARCH_SNIPPETS) {
        matches.push({ line: i + 1, text: snippet(line, at, q.length) });
      }
    });
    const titleHit = title.toLowerCase().includes(q) || doc.path.toLowerCase().includes(q);
    if (!count && !titleHit) continue;
    hits.push({ path: doc.path, title, rank: titleHit ? 0 : headingHit ? 1 : 2, matches, count });
  }
  hits.sort((a, b) => a.rank - b.rank || b.count - a.count || a.path.localeCompare(b.path));
  return hits.slice(0, limit).map(({ count: _count, ...hit }) => hit);
}

// ---------------------------------------------------------------------------
// Session & machine sharing
// ---------------------------------------------------------------------------

/**
 * What a guest may do on someone else's machine.
 *
 * A share is never boolean: a guest runs code on the host's computer, as the
 * host's OS user, on the host's Anthropic plan. Every grant carries this flag
 * set, and the bridge is what enforces it — storage and the relay only carry it.
 *
 * The UI exposes presets only (see SHARE_PRESETS); the flags exist so a finer
 * grant can ship later without a migration.
 */
export interface ShareCaps {
  /** Send prompts at all. */
  prompt: boolean;
  /** A guest prompt lands paused in the owner's queue instead of running. */
  promptNeedsApproval: boolean;
  /** Read workspace files, trees, docs — clamped to the shared session's roots. */
  readFiles: boolean;
  /** Stop, retry, continue, cancel a queued prompt. */
  interrupt: boolean;
  /** Answer a permission request. This is the one that runs arbitrary commands. */
  approvePermissions: boolean;
  /** Approve, force-advance, start or retry a workflow step. */
  manageWorkflow: boolean;
  setModel: boolean;
  /** No preset grants this: permission mode is the guard around everything else. */
  setPermissionMode: boolean;
  /** Machine-scope grants only — a session share has no folder to create in. */
  createSessions: boolean;
}

/** Every capability off. The base every grant is built from, so a new flag defaults denied. */
export const NO_SHARE_CAPS: ShareCaps = {
  prompt: false,
  promptNeedsApproval: false,
  readFiles: false,
  interrupt: false,
  approvePermissions: false,
  manageWorkflow: false,
  setModel: false,
  setPermissionMode: false,
  createSessions: false,
};

/** The three grants the UI offers. Stored as caps, so the preset is only a label. */
export type SharePreset = 'view' | 'prompt' | 'collaborator';

/** How wide a grant reaches. `owner` is the host themselves — never a stored row. */
export type ShareScope = 'owner' | 'machine' | 'session';

export const SHARE_PRESETS: Record<SharePreset, ShareCaps> = {
  view: { ...NO_SHARE_CAPS, readFiles: true },
  prompt: {
    ...NO_SHARE_CAPS,
    prompt: true,
    // The default that makes "can prompt" safe to hand out: the owner releases
    // each one from the queue UI they already have, and answers every permission.
    promptNeedsApproval: true,
    readFiles: true,
  },
  collaborator: {
    ...NO_SHARE_CAPS,
    prompt: true,
    readFiles: true,
    interrupt: true,
    approvePermissions: true,
    manageWorkflow: true,
    setModel: true,
  },
};

/**
 * Caps for a preset at a given scope. `createSessions` is the only capability
 * that depends on scope — there is nowhere to put a new session in a session
 * share.
 */
export function capsForPreset(preset: SharePreset, scope: ShareScope): ShareCaps {
  const caps = { ...SHARE_PRESETS[preset] };
  if (preset === 'collaborator' && scope === 'machine') caps.createSessions = true;
  return caps;
}

/**
 * Read caps back out of a stored JSON blob, **failing closed**: anything missing,
 * malformed, or not a boolean is denied rather than assumed.
 *
 * The load-bearing case is a capability added after a grant was written — an old
 * row must not silently acquire it, which is exactly what spreading the stored
 * object over a permissive default would do.
 */
export function parseShareCaps(value: unknown): ShareCaps {
  const raw = (value ?? {}) as Record<string, unknown>;
  const caps = { ...NO_SHARE_CAPS };
  for (const key of Object.keys(NO_SHARE_CAPS) as (keyof ShareCaps)[]) {
    caps[key] = raw[key] === true;
  }
  return caps;
}

/** Which preset a stored cap set corresponds to, or null for a hand-tuned grant. */
export function presetOfCaps(caps: ShareCaps, scope: ShareScope): SharePreset | null {
  for (const preset of ['view', 'prompt', 'collaborator'] as SharePreset[]) {
    const expected = capsForPreset(preset, scope);
    if ((Object.keys(expected) as (keyof ShareCaps)[]).every((k) => expected[k] === caps[k])) {
      return preset;
    }
  }
  return null;
}

/**
 * Who did a thing, for attribution in a shared session.
 *
 * Taken from the connection's attested identity, never from a message body — the
 * same rule as presence. A prompt that could claim to be from someone else would
 * make the whole transcript untrustworthy.
 *
 * Absent on every row written before sharing existed, which is why every reader
 * falls back to the session's host rather than rendering "unknown".
 */
export interface Actor {
  userId: string;
  name: string | null;
  imageUrl: string | null;
}

/** Display identity for a person in a shared session. Never client-supplied. */
export interface ShareProfile {
  userId: string;
  email: string | null;
  name: string | null;
  imageUrl: string | null;
}

/**
 * One person watching a session, as the bridge sees them.
 *
 * Ephemeral and bridge-local: presence lives in memory on the host, never in
 * `SessionMeta`. A focus toggle riding the session blob would restamp
 * `updatedAt` and write a Postgres row per keystroke.
 *
 * `profile` is the relay-attested identity, or null for the session's own host
 * (whose display name the viewer already has from `hello.access.ownerProfile`).
 * Never taken from a message body — attribution must not be spoofable.
 */
export interface PresenceViewer {
  userId: string;
  /** Distinguishes two tabs of the same person, so leaving one does not clear both. */
  connId: string;
  profile: ShareProfile | null;
  /** This session is on screen for them. */
  viewing: boolean;
  /** Their composer has focus — they are probably typing. */
  focused: boolean;
  /** ms epoch of their last signal. */
  lastSeenAt: number;
}

/**
 * What one browser connection may do, attached to the socket rather than to the
 * user: the same person can hold a wide grant on one machine and a narrow one on
 * another, and the bridge answers per connection.
 */
export interface SocketAccess {
  scope: ShareScope;
  caps: ShareCaps;
  /** Session scope only — exactly the sessions this connection may touch. */
  sessionIds?: string[];
  /** The host, for a guest's UI. Null for the owner's own connection. */
  ownerProfile?: ShareProfile | null;
  /**
   * *This viewer's* display identity, resolved server-side from the cached
   * UserProfile — never from a message body, so presence and attribution cannot
   * be spoofed. Null for the machine's owner, whose name the client already knows
   * from Clerk.
   */
  viewerProfile?: ShareProfile | null;
}

/** The owner's own connection: every capability, no session limit. */
export const OWNER_ACCESS: SocketAccess = {
  scope: 'owner',
  caps: {
    prompt: true,
    promptNeedsApproval: false,
    readFiles: true,
    interrupt: true,
    approvePermissions: true,
    manageWorkflow: true,
    setModel: true,
    setPermissionMode: true,
    createSessions: true,
  },
};

/**
 * What a message requires of the connection that sent it.
 *
 * - `owner` — never grantable to anyone, at any preset.
 * - `connection` — about the socket itself (heartbeat, token relay), so every
 *   connection may send it. Carries no access to the user's data.
 * - `cap` — any grant holding the capability. Not session-scoped, so the
 *   enforcement of *what* it may touch lives in the handler (see fileRequest,
 *   clamped to the grant's roots).
 * - `session` — session-scoped: the message's `sessionId` must be inside the
 *   grant, and the capability (when not null) must be held.
 * - `machine` — machine-scope grants only; a session share has no standing.
 */
export type MessageAuthz =
  | { needs: 'owner' }
  | { needs: 'connection' }
  | { needs: 'cap'; cap: keyof ShareCaps }
  | { needs: 'session'; cap: keyof ShareCaps | null }
  | { needs: 'machine'; cap: keyof ShareCaps };

/**
 * Every client message, classified. **Do not weaken this to a partial map or a
 * lookup with a fallback**: keying the Record on `ClientMessage['type']` means a
 * message added later fails to compile until someone decides what it grants,
 * which makes default-deny a property the compiler enforces rather than one a
 * reviewer has to notice.
 */
export const MESSAGE_AUTHZ: Record<ClientMessage['type'], MessageAuthz> = {
  // --- the socket itself
  ping: { needs: 'connection' },
  auth: { needs: 'connection' },

  // --- running a session
  prompt: { needs: 'session', cap: 'prompt' },
  interrupt: { needs: 'session', cap: 'interrupt' },
  stopBackgroundTasks: { needs: 'session', cap: 'interrupt' },
  retryTurn: { needs: 'session', cap: 'interrupt' },
  continueTurn: { needs: 'session', cap: 'interrupt' },
  cancelQueued: { needs: 'session', cap: 'interrupt' },
  // Deliberately `prompt`, not the `interrupt` cancelQueued sits at: rewriting a
  // prompt that has not been sent yet is the same authority as writing it, and
  // the Can prompt preset — the one whose prompts land paused for approval —
  // grants `prompt` without `interrupt`. Under `interrupt` the main use case, a
  // guest fixing their own pending prompt, would be denied. Who may edit *which*
  // item (author, or the owner) is a second check in SessionManager.editQueued.
  editQueued: { needs: 'session', cap: 'prompt' },
  // `prompt` for the same reason editQueued is: this *delivers* a prompt, so it
  // is the authority to write one, not the authority to interrupt. What this
  // table cannot express is "prompt but **not** `promptNeedsApproval`" — a guest
  // whose prompts are held for review must not release their own by pressing
  // Send now. That refusal is the first line of SessionManager.interjectQueued.
  interjectQueued: { needs: 'session', cap: 'prompt' },
  // Destructive to the session's context, so it sits with the other turn-level
  // controls rather than with reads.
  compactContext: { needs: 'session', cap: 'interrupt' },
  // Destructive to the session's context *and* to its transcript, so it sits with
  // compactContext and interrupt rather than with prompt. Deliberately not `prompt`
  // (which editQueued uses): rewinding discards turns somebody else may have run.
  rewindSession: { needs: 'session', cap: 'interrupt' },
  permissionResponse: { needs: 'session', cap: 'approvePermissions' },
  setModel: { needs: 'session', cap: 'setModel' },
  // No preset grants this: permission mode is the guard around everything else.
  setPermissionMode: { needs: 'session', cap: 'setPermissionMode' },

  // --- watching a session. `cap: null` = any grant, including View only.
  loadTranscript: { needs: 'session', cap: null },
  // Any grant, View only included: being seen in a session you may watch is the
  // point, and it grants nothing.
  presence: { needs: 'session', cap: null },
  ackSession: { needs: 'session', cap: null },
  contextBreakdown: { needs: 'session', cap: 'readFiles' },

  // --- workflow driving
  workflowApprove: { needs: 'session', cap: 'manageWorkflow' },
  workflowForceAdvance: { needs: 'session', cap: 'manageWorkflow' },
  workflowStartStep: { needs: 'session', cap: 'manageWorkflow' },
  workflowRetry: { needs: 'session', cap: 'manageWorkflow' },

  // --- files. Scope enforcement is in the handler, not here.
  fileRequest: { needs: 'cap', cap: 'readFiles' },

  // --- creating sessions: machine scope only, since a session share has no
  //     folder to create in.
  createSession: { needs: 'machine', cap: 'createSessions' },

  // --- owner only, permanently.
  //     A guest must never reshape the host's library, projects, settings,
  //     account or machine — and must never delete their sessions.
  deleteSession: { needs: 'owner' },
  archiveSession: { needs: 'owner' },
  unarchiveSession: { needs: 'owner' },
  completeSession: { needs: 'owner' },
  saveWorkflow: { needs: 'owner' },
  deleteWorkflow: { needs: 'owner' },
  saveStep: { needs: 'owner' },
  deleteStep: { needs: 'owner' },
  stepVersions: { needs: 'owner' },
  saveRecipe: { needs: 'owner' },
  deleteRecipe: { needs: 'owner' },
  recipeVersions: { needs: 'owner' },
  uploadRecipeImage: { needs: 'owner' },
  // Creates sessions *and* workflows from the owner's library — wider than
  // createSession, so no preset reaches it.
  runRecipe: { needs: 'owner' },
  pickFolder: { needs: 'owner' },
  openProject: { needs: 'owner' },
  closeProject: { needs: 'owner' },
  addProjectRoot: { needs: 'owner' },
  removeProjectRoot: { needs: 'owner' },
  createWorktree: { needs: 'owner' },
  removeWorktree: { needs: 'owner' },
  linkProjectPath: { needs: 'owner' },
  authStartLogin: { needs: 'owner' },
  authCompleteLogin: { needs: 'owner' },
  authLogout: { needs: 'owner' },
  saveSettings: { needs: 'owner' },
  addGuardAllow: { needs: 'owner' },
  removeGuardAllow: { needs: 'owner' },
  reviewGuardAllowlist: { needs: 'owner' },
  // MCP connections run third-party code (or ship the host's credentials to a
  // third party) inside every session on this machine — owner only, permanently.
  addMcpConnection: { needs: 'owner' },
  updateMcpConnection: { needs: 'owner' },
  removeMcpConnection: { needs: 'owner' },
  reviewMcpConnections: { needs: 'owner' },
  // Reports the host's configured servers (names, urls, errors), so it is owner
  // only for the same reason the Connections pane itself is.
  mcpServerStatus: { needs: 'owner' },
  // Sends the host's browser to a third party and stores a credential on their
  // machine. Owner only, permanently.
  authorizeMcpConnection: { needs: 'owner' },
  installUpdate: { needs: 'owner' },
};

/**
 * May this connection send this message? One gate, consulted before any handler
 * runs, denying by default.
 *
 * The refusal text is shown to the guest, so it says which capability is missing
 * rather than a bare "unauthorized" — the commonest real case is a View-only
 * guest trying to prompt, and "you can't do that" with no reason is unhelpable.
 */
export function authorizeMessage(
  msg: ClientMessage,
  access: SocketAccess,
): { ok: true } | { ok: false; reason: string } {
  const rule = MESSAGE_AUTHZ[msg.type];
  // Not classified: deny. Unreachable while the Record above is exhaustive, and
  // the point is that it stays true even if that guarantee is ever weakened.
  if (!rule) return { ok: false, reason: 'That action is not available.' };
  if (access.scope === 'owner') return { ok: true };

  switch (rule.needs) {
    case 'connection':
      return { ok: true };
    case 'owner':
      return { ok: false, reason: 'Only the owner of this machine can do that.' };
    case 'machine':
      if (access.scope !== 'machine') {
        return { ok: false, reason: 'That needs access to the whole machine, not one session.' };
      }
      return access.caps[rule.cap] ? { ok: true } : { ok: false, reason: denial(rule.cap) };
    case 'cap':
      return access.caps[rule.cap] ? { ok: true } : { ok: false, reason: denial(rule.cap) };
    case 'session': {
      const sessionId = (msg as { sessionId?: string }).sessionId;
      if (!sessionId) return { ok: false, reason: 'That action is not available.' };
      // A machine-scope grant covers every session on the machine; a session
      // share covers exactly its list, so a sibling session is refused here.
      if (access.scope === 'session' && !access.sessionIds?.includes(sessionId)) {
        return { ok: false, reason: 'You do not have access to that session.' };
      }
      if (rule.cap && !access.caps[rule.cap]) return { ok: false, reason: denial(rule.cap) };
      return { ok: true };
    }
  }
}

const DENIAL_REASONS: Record<keyof ShareCaps, string> = {
  prompt: 'You have view-only access to this session.',
  promptNeedsApproval: 'Your prompts need the owner’s approval.',
  readFiles: 'You do not have access to files on this machine.',
  interrupt: 'Only a collaborator can stop or retry a turn.',
  approvePermissions: 'Only the owner can answer a permission request here.',
  manageWorkflow: 'Only a collaborator can drive workflow steps.',
  setModel: 'Only a collaborator can change the model.',
  setPermissionMode: 'Only the owner of this machine can change that.',
  createSessions: 'You cannot create sessions on this machine.',
};

const denial = (cap: keyof ShareCaps): string => DENIAL_REASONS[cap];

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | {
      type: 'createSession';
      name: string;
      cwd: string;
      model: string;
      permissionMode: PermissionMode;
      workflowId?: string;
      /**
       * Opt-in: cut a fresh worktree+branch off `cwd`'s repo and run the session
       * there. Rides on createSession rather than a message of its own because the
       * session's cwd must *be* the worktree from the first upsert — cwd is
       * identity (project-key anchor, recentDirs, roots, attribution) and is never
       * rewritten. An object, not a boolean, so it can carry an explicit branch.
       */
      worktree?: { branch?: string; baseRef?: string };
    }
  | { type: 'deleteSession'; sessionId: string }
  | {
      type: 'prompt';
      sessionId: string;
      text: string;
      attachments?: PromptAttachment[];
      mentions?: PromptMention[];
      /** Pre-expansion draft, kept only if the prompt is queued (see {@link QueuedPrompt.draft}). */
      draft?: MentionValue;
    }
  | { type: 'interrupt'; sessionId: string }
  /** Stop every background task the session's CLI process still owns. Separate
   *  from `interrupt`, which only kills the foreground turn. */
  | { type: 'stopBackgroundTasks'; sessionId: string }
  | { type: 'retryTurn'; sessionId: string }
  | { type: 'continueTurn'; sessionId: string }
  | { type: 'cancelQueued'; sessionId: string; queuedId: string }
  | {
      type: 'editQueued';
      sessionId: string;
      queuedId: string;
      /** Expanded text, exactly what `prompt` carries. */
      text: string;
      mentions?: PromptMention[];
      /** Pre-expansion draft, so the next edit still has its pills. */
      draft?: MentionValue;
      addAttachments?: PromptAttachment[];
      /** `Attachment.url`s to drop — a delta, so an omitted field cannot wipe the set. */
      removeAttachments?: string[];
    }
  /** "Send now": lift a queued item out of the queue and deliver it into the
   *  running turn. Names the item, never resends its text — same shape as
   *  cancelQueued. */
  | { type: 'interjectQueued'; sessionId: string; queuedId: string }
  | { type: 'ackSession'; sessionId: string }
  | { type: 'archiveSession'; sessionId: string }
  | { type: 'unarchiveSession'; sessionId: string }
  | { type: 'completeSession'; sessionId: string }
  | { type: 'setModel'; sessionId: string; model: string }
  | { type: 'setPermissionMode'; sessionId: string; mode: PermissionMode }
  | {
      type: 'permissionResponse';
      sessionId: string;
      requestId: string;
      allow: boolean;
      /** Replaces the tool input when allowing (AskUserQuestion answers, sanitized args, ...). */
      updatedInput?: Record<string, unknown>;
      /** Display-only copy of chosen answers for transcript rendering. */
      answers?: Record<string, string>;
      /** Sent to Claude as the reason when allow=false. */
      denyMessage?: string;
      /** Add this request's pattern to the auto-mode guard allowlist. */
      alwaysAllow?: boolean;
      /**
       * ExitPlanMode only: notes the user attached to passages of the plan. On an
       * approval they ride into the running turn as an interjection; on a deny the
       * server builds the reason from them, ignoring `denyMessage`. Re-validated
       * server-side with `normalizePlanComments` — the client is not trusted.
       */
      planComments?: PlanComment[];
    }
  | { type: 'workflowApprove'; sessionId: string; stepIndex: number }
  /** Mark the current step done from the stepper, whether it is parked or still running. */
  | { type: 'workflowForceAdvance'; sessionId: string; stepIndex: number }
  /** Run the current step's first turn when an advance landed on it but never queued one. */
  | { type: 'workflowStartStep'; sessionId: string; stepIndex: number }
  | { type: 'workflowRetry'; sessionId: string; stepIndex: number; feedback: string }
  | { type: 'saveWorkflow'; workflow: WorkflowDef; ownerName?: string }
  | { type: 'deleteWorkflow'; workflowId: string }
  /** Save or update a step. Content changes bump the version; `published` shares it instance-wide. Server stamps ownerId. */
  | { type: 'saveStep'; step: StepContent; stepId?: string; published: boolean; ownerName?: string }
  /** Remove a step from the library (existing pins keep resolving the immutable versions). */
  | { type: 'deleteStep'; stepId: string }
  /** Request the full version history of a step (for preview + re-pin). Keys are echoed back. */
  | { type: 'stepVersions'; ownerId: string; stepId: string }
  /** Save or update a recipe. Content changes bump the version; server stamps ownerId and normalizes tags. */
  | { type: 'saveRecipe'; recipe: RecipeContent; recipeId?: string; published: boolean; ownerName?: string }
  /** Remove a recipe from the library — an unpublish, mirroring deleteStep; rows stay. */
  | { type: 'deleteRecipe'; recipeId: string }
  /** Request the full version history of a recipe. Keys are echoed back. */
  | { type: 'recipeVersions'; ownerId: string; recipeId: string }
  /** Upload one recipe screenshot; answered with the public URL. `data` is raw base64. */
  | { type: 'uploadRecipeImage'; uploadId: string; name: string; mediaType: string; data: string }
  | {
      type: 'runRecipe';
      /** Correlation id echoed on `recipeRun` — the protocol has none of its own. */
      runId: string;
      /**
       * Ad-hoc selection, order = execution order. A single entry that resolves to
       * a saved bundle is expanded server-side into its members, so the client
       * never flattens (and a stale client can't run a bundle's old membership).
       * One leaf = a plain session; more than one, or a bundle = a synthesized workflow.
       */
      recipes: { ownerId: string; recipeId: string; version?: number }[];
      cwd: string;
      model: string;
      permissionMode: PermissionMode;
      /** Bundle runs only — the name of the workflow that gets created. */
      bundleName?: string;
      /** Bundle runs only: false parks for review between recipes. */
      autoAdvance?: boolean;
      /** Single-leaf only — mutually exclusive with a bundle, which already is a workflow. */
      workflowId?: string;
    }
  /** Live `/context` breakdown for one session (hover-triggered). Echoed back. */
  | { type: 'contextBreakdown'; sessionId: string }
  /** Compact this session's context now (manual compaction). */
  | { type: 'compactContext'; sessionId: string }
  /**
   * Rewind the session to the `kind: 'user'` transcript event at `seq`: everything
   * from that event on is dropped and the CLI conversation is re-pointed at the
   * truncated history.
   *
   * `edit` decides what happens to the rewound prompt itself. True answers with
   * `rewound` so the composer can prefill it for editing and re-sending; false
   * (the default) discards it with the rest of the tail. Neither ever re-submits.
   */
  | { type: 'rewindSession'; sessionId: string; seq: number; edit?: boolean }
  | { type: 'loadTranscript'; sessionId: string }
  /**
   * "I am looking at this session" / "my composer has focus". Debounced hard on
   * the client: writeDraft already fires per keystroke and this must not become
   * one frame per character.
   */
  | { type: 'presence'; sessionId: string; viewing: boolean; focused: boolean }
  | { type: 'pickFolder' }
  | { type: 'openProject'; path: string }
  | { type: 'closeProject'; path: string }
  /** Widen a project to span another folder. Two explicit intents rather than
   *  overloading `openProject`, so "new tab" and "new root" never get confused. */
  | { type: 'addProjectRoot'; project: string; path: string }
  | { type: 'removeProjectRoot'; project: string; path: string }
  /** Cut a linked work tree off a project's repo. Two explicit intents, as the
   *  root messages above: creating a checkout and destroying one must never share
   *  a payload shape. */
  | { type: 'createWorktree'; project: string; branch: string; baseRef?: string; path?: string }
  /** `git worktree remove` (its files go with it), plus `git branch -d` when asked.
   *  `force` is the escalation offered only after git has refused once. */
  | { type: 'removeWorktree'; project: string; path: string; deleteBranch?: boolean; force?: boolean }
  /** Manually bind a path to a project key — for a cwd that doesn't exist on this machine. */
  | { type: 'linkProjectPath'; path: string; key: string }
  | { type: 'authStartLogin' }
  | { type: 'authCompleteLogin'; code: string }
  | { type: 'authLogout' }
  /** Fresh Clerk token relay (~50s cadence) so the bridge's per-connection token never expires. */
  | { type: 'auth'; token: string }
  | { type: 'saveSettings'; settings: UserUiSettings }
  /** Auto-mode guard allowlist edits. Intent messages, not a whole-list save: the
   *  server also writes entries on its own (permission cards), so a whole-list
   *  payload from a stale tab would clobber them. */
  | { type: 'addGuardAllow'; entry: GuardAllowEntry }
  | { type: 'removeGuardAllow'; entry: GuardAllowEntry }
  /** Resolve a pending remote-divergence review: accept installs it, reject keeps local. */
  | { type: 'reviewGuardAllowlist'; accept: boolean }
  /**
   * MCP connection edits. Intent messages for the same reason the guard's are:
   * the bridge holds header values the client has never seen, so a whole-list
   * payload from a stale tab would erase them.
   *
   * `headers` carries the secret values for `connection.headerKeys`. It travels
   * client -> bridge only and is written to a local-only file; nothing ever
   * sends one back.
   */
  | { type: 'addMcpConnection'; connection: McpConnectionInput; headers?: Record<string, string> }
  | {
      type: 'updateMcpConnection';
      id: string;
      connection: McpConnectionInput;
      headers?: Record<string, string>;
    }
  | { type: 'removeMcpConnection'; id: string }
  | { type: 'reviewMcpConnections'; accept: boolean }
  /**
   * Read how each MCP server is doing in one session; answered by
   * `mcpServerStatus`.
   *
   * `warm: true` permits the bridge to bring the session's query up if it has
   * none, which is the only way to get a real reading for a session that has
   * never run a turn. Sent on an explicit Refresh, never on the pane merely
   * opening — a status read must not spawn a CLI child as a side effect.
   */
  | { type: 'mcpServerStatus'; sessionId: string; warm?: boolean }
  /**
   * Start an OAuth handshake for one MCP server, using `sessionId`'s live query.
   * Answered by `mcpAuthStarted`. The session matters: the CLI process that runs
   * this leg holds the PKCE verifier, so the callback must come back to it.
   */
  | { type: 'authorizeMcpConnection'; sessionId: string; name: string }
  /** Read a workspace file/tree/docs bundle, search files, or fetch an attachment.
   *  `reqId` is echoed on the matching fileResponse. */
  | { type: 'fileRequest'; reqId: string; kind: FileRequestKind; params: FileRequestParams }
  /** Apply a downloaded update now. Ignored while a session is active. */
  | { type: 'installUpdate' }
  | { type: 'ping' };

/** One Claude-plan rate-limit window (5-hour session, weekly, ...) from the OAuth usage endpoint. */
export interface UsageWindow {
  /** Raw key from the API, e.g. 'five_hour' | 'seven_day' | 'seven_day_opus'. */
  id: string;
  /** Percent of the window consumed, 0-100. */
  utilization: number;
  /** ISO timestamp when the window resets, or null if the API omitted it. */
  resetsAt: string | null;
}

/** Snapshot of Claude-plan usage, polled by the bridge and mirrored to browsers. */
export interface UsageSnapshot {
  windows: UsageWindow[];
  /** ms epoch of the successful fetch (drives the staleness footer). */
  fetchedAt: number;
}

/** Whether the app is logged in to Claude, plus the account it's using (from the OAuth token response). */
export interface AuthStatus {
  loggedIn: boolean;
  account?: { email?: string; organization?: string };
}

/**
 * What kind of failure took the storage link down. Coarse on purpose: each class
 * gets its own banner wording, and `auth` is the one the bridge waits out rather
 * than reports (an expired Clerk token is not an outage).
 */
export type StorageErrorKind = 'auth' | 'network' | 'timeout' | 'server' | 'client';

/** Bridge -> storage-server link health. `available: false` = the storage server / Supabase is unreachable. */
export interface StorageStatus {
  available: boolean;
  /** Underlying error (Prisma/DB message or transport failure), when known. */
  reason?: string;
  /** Class of the failure that took the link down. Absent while available. */
  kind?: StorageErrorKind;
  /** Epoch ms the outage started, as WorkerStatus.since. Absent while available. */
  since?: number;
  /** Consecutive failed requests in this outage. */
  failures?: number;
}

/**
 * One row of the bridge's `sync-log.jsonl`, written only on a failed request or
 * an availability transition — the happy path costs no IO. Read back by the
 * `syncLog` file request so a user can see (and paste) why sync went down.
 */
export interface SyncLogEntry {
  /** ms epoch. */
  at: number;
  event: 'fail' | 'down' | 'up';
  kind?: StorageErrorKind;
  method?: string;
  /** Request path, query stripped (a `?since=` cursor says nothing useful here). */
  path?: string;
  /** HTTP status, when the server answered at all. */
  status?: number;
  /** Request duration in ms. */
  ms?: number;
  reason?: string;
  /** Consecutive failures counted at the time of the row. */
  failures?: number;
  /** `up` only: how long the outage lasted, ms. */
  downMs?: number;
}

/** Bridge->worker socket health. App-wide: one worker per bridge, not per session. */
export interface WorkerStatus {
  /** false once the socket has been down past WORKER_LOST_MS, or on a protocol mismatch. */
  connected: boolean;
  /** Epoch ms the socket went down. Absent while connected. */
  since?: number;
  /**
   * Present instead of a plain outage when a worker answered on a version this
   * bridge can't speak. The remedy differs (restart the *other* process), so the
   * copy differs.
   */
  mismatch?: { worker: number; bridge: number };
}

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

/** Per-user UI settings mirrored to the storage server; localStorage stays the offline cache. */
export interface UserUiSettings {
  newSessionDefaults?: { model: string; permissionMode: PermissionMode };
  sidebarMode?: 'sessions' | 'files';
  compactionLevel?: 'full' | 'grouped' | 'compact';
  turnSummariesEnabled?: boolean;
  /**
   * Resume a turn that died with the app instead of waiting for the Continue
   * banner to be clicked. On unless explicitly `false` — absent means enabled,
   * so a fresh install recovers without configuration. Only sessions flagged by
   * the reconcile that just ran are resumed: a flag left over from an earlier
   * crash still needs the click, so a restart can't fan out into a pile of
   * unattended turns.
   */
  autoContinueInterrupted?: boolean;
  /** Append the response-compression ruleset to every session's system prompt.
   *  On unless explicitly `false` — absent means enabled. Global: sessions no
   *  longer carry their own toggle, so changing it applies the next time each
   *  session's worker starts a fresh query (not to one already running). */
  compressResponses?: boolean;
  alertsEnabled?: boolean;
  alertSound?: string;
  /**
   * Working directories the user has marked as "not one of my projects", so the
   * unlinked-checkout hint stops offering them. Purely a UI dismissal — it never
   * claims an identity for the path, so a real key arriving later still wins.
   */
  dismissedCheckouts?: string[];
  /** ms epoch of the last change — last-write-wins key. */
  updatedAt?: number;
}

/**
 * Machine-independent project identity, keyed by working directory.
 *
 * A session's `cwd` is an absolute path on the machine that created it, so the
 * same repo checked out at `~/Projects/lines` and `~/Projects/lines-clone` looks
 * like two projects. Each bridge resolves the checkouts it can see to a stable
 * key (`<normalized git remote>#<path within the repo>`) and the map is synced,
 * so every machine can group sessions by repo even for paths it doesn't have.
 * A cwd with no resolvable key is absent here and falls back to path equality.
 */
export type ProjectKeyMap = Record<string, string>;

/**
 * One linked git work tree of a project's repo. A cache of git truth, not the
 * source of it: `git worktree list` is authoritative, and a record whose
 * directory is gone is dropped rather than repaired.
 *
 * An *attribution* path, never a capability root — see `projectPaths`.
 */
export interface WorktreeInfo {
  /** Absolute; unique across the whole projects list. */
  path: string;
  /** Absent when detached. */
  branch?: string;
  /** Display only — what the branch was cut from. */
  baseRef?: string;
  /** Absent when discovered from git rather than created here. */
  createdAt?: number;
  /** Set by auto-per-session, so an orphan is nameable. */
  sessionId?: string;
  /** Only then may removal offer to delete the branch. */
  createdByLines?: true;
}

/**
 * One project tab. `path` stays the project's identity — the tab key, the
 * `activeProject` value, every session's `cwd`, and the project-key anchor — so
 * spanning extra folders changes nothing that is persisted or synced elsewhere.
 *
 * `worktrees` is a third kind of path: attribution without capability. A worktree
 * session shows in this tab, but the worktree is never one of the tab's roots —
 * inheriting them would let the agent write in the parent checkout and undo the
 * isolation the worktree exists for.
 */
export interface Project {
  /** Absolute path; the project's identity — tab key, activeProject, session cwd, project-key anchor. */
  path: string;
  /** Extra absolute roots the agent may also work in. Never contains `path`. */
  extraRoots?: string[];
  /** Linked work trees of this repo. Not roots — see `projectRoots` vs `projectPaths`. */
  worktrees?: WorktreeInfo[];
}

/** Strip trailing slashes; '/' survives. The one normalizer every root path goes through. */
export function normalizeRootPath(raw: string): string {
  const trimmed = raw.trim();
  const stripped = trimmed.replace(/\/+$/, '');
  return stripped || (trimmed ? '/' : '');
}

/** Every root the project spans, primary first. */
export function projectRoots(p: Project): string[] {
  return [p.path, ...(p.extraRoots ?? [])];
}

/** Every linked work tree path of the project, in record order. */
export function worktreePaths(p: Project): string[] {
  return (p.worktrees ?? []).map((w) => w.path);
}

/**
 * Every path attributed to the project: its roots first, then its work trees.
 *
 * The counterpart to `projectRoots`, and deliberately not a superset of it in
 * meaning. `projectRoots` answers "what may a session here write to" (capability)
 * and must never grow a worktree path. `projectPaths` answers "which tab does
 * this directory belong to" (attribution) — session grouping, tab labels, the
 * unlinked-checkout hint. Never pass this to the guard or to
 * `additionalDirectories`.
 */
export function projectPaths(p: Project): string[] {
  return [...projectRoots(p), ...worktreePaths(p)];
}

/** The project whose work tree `cwd` is, plus that record. */
export function findWorktree(
  projects: Project[],
  cwd: string,
): { project: Project; worktree: WorktreeInfo } | null {
  for (const project of projects) {
    const worktree = (project.worktrees ?? []).find((w) => w.path === cwd);
    if (worktree) return { project, worktree };
  }
  return null;
}

/** The project owning `cwd` — primary match first, then extra-root match. */
export function findProject(projects: Project[], cwd: string): Project | null {
  return (
    projects.find((p) => p.path === cwd) ??
    projects.find((p) => (p.extraRoots ?? []).includes(cwd)) ??
    null
  );
}

/**
 * Roots a session at `cwd` may touch: its project's roots, else `[cwd]`. Never
 * empty — an empty list would make the guard escalate every single file call.
 */
export function rootsForCwd(projects: Project[], cwd: string): string[] {
  // A worktree session is deliberately confined to its own checkout; inheriting the
  // parent's roots would defeat the isolation. `[cwd]` keeps the never-empty rule.
  if (findWorktree(projects, cwd)) return [cwd];
  const project = findProject(projects, cwd);
  return project ? projectRoots(project) : [cwd];
}

/**
 * One synced agent-memory file. The SDK reads memory only off disk, so disk
 * stays the SDK-facing cache and this map is the cross-machine source of truth,
 * merged per-file last-write-wins on the storage server.
 */
export interface MemoryFileEntry {
  content: string; // utf8
  updatedAt: number; // ms epoch from file mtime — per-file LWW
  deleted?: true; // tombstone
}

/**
 * Keys are one of:
 *   "user/CLAUDE.md"                        — user-level memory
 *   "project/<projectKey>/memory/<rel>"     — per-repo auto-memory (machine-independent)
 *   "slug/<slug>/memory/<rel>"              — fallback for a dir with no resolvable key
 */
export type MemoryFileMap = Record<string, MemoryFileEntry>;

// ---------------------------------------------------------------------------
// Auto-mode guard allowlist
// ---------------------------------------------------------------------------

/** Tools that must always reach the user regardless of guard verdicts. */
export const ALWAYS_ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** User-built exception to the auto-mode guard. */
export interface GuardAllowEntry {
  tool: string;
  /** For Bash: command prefix, e.g. "npm run". Absent for every other tool. */
  prefix?: string;
}

/** The synced form of the allowlist. `updatedAt` only orders writes at the storage row —
 *  divergence detection is a set difference, never a timestamp comparison. */
export interface GuardAllowlistBlob {
  entries: GuardAllowEntry[];
  updatedAt: number;
}

/** A remote allowlist awaiting explicit accept/reject. `entries` is what accept installs verbatim. */
export interface GuardAllowlistReview {
  entries: GuardAllowEntry[];
  /** In remote, not local — would become newly permitted. */
  added: GuardAllowEntry[];
  /** In local, not remote — would stop being permitted. */
  removed: GuardAllowEntry[];
  /** ms epoch the divergence was first staged; a stable client dedupe key. */
  detectedAt: number;
}

export type GuardEntryError =
  | 'empty-tool'
  | 'bad-tool'
  | 'always-ask'
  | 'bash-needs-prefix'
  | 'prefix-chained'
  | 'prefix-too-long';

/** Wide enough for `mcp__server__tool`, narrow enough that a row can't render markup. */
const GUARD_TOOL_RE = /^[A-Za-z][\w.-]{0,127}$/;
const GUARD_PREFIX_MAX_LEN = 200;

/**
 * Canonical form of an allowlist entry, or why it was refused. The single gate
 * every writer runs through — the permission card, the Settings form, the load
 * migration, and remote ingest — so a hand-typed entry can never end up in a
 * shape the guard's matching rules cannot match.
 */
export function normalizeAllowEntry(
  raw: { tool: string; prefix?: string },
): { entry: GuardAllowEntry } | { error: GuardEntryError } {
  // Untrusted callers (disk, a storage row) reach this too, so nothing is assumed.
  const src = (raw ?? {}) as { tool?: unknown; prefix?: unknown };
  const tool = typeof src.tool === 'string' ? src.tool.trim() : '';
  if (!tool) return { error: 'empty-tool' };
  if (!GUARD_TOOL_RE.test(tool)) return { error: 'bad-tool' };
  // The guard short-circuits on these *before* consulting the allowlist, so such
  // an entry would be permanently inert — a row that lies about what it does.
  if (ALWAYS_ASK_TOOLS.has(tool)) return { error: 'always-ask' };
  // Dropped rather than rejected: `{ tool }` is the only shape the tool-name
  // branch of the guard compares against.
  if (tool !== 'Bash') return { entry: { tool } };
  const rawPrefix = typeof src.prefix === 'string' ? src.prefix : '';
  // Dead by construction — the guard splits commands on exactly these before matching.
  if (/[|;&\n\r]/.test(rawPrefix)) return { error: 'prefix-chained' };
  // Same whitespace collapse the permission card applies, or `git   status`
  // could never match a real command segment.
  const prefix = rawPrefix.trim().split(/\s+/).filter(Boolean).join(' ');
  if (!prefix) return { error: 'bash-needs-prefix' };
  if (prefix.length > GUARD_PREFIX_MAX_LEN) return { error: 'prefix-too-long' };
  return { entry: { tool, prefix } };
}

export function sameAllowEntry(a: GuardAllowEntry, b: GuardAllowEntry): boolean {
  return a.tool === b.tool && (a.prefix ?? '') === (b.prefix ?? '');
}

/** Human-readable row label, e.g. "Bash: npm run" / "WebFetch". */
export function describeAllowEntry(e: GuardAllowEntry): string {
  return e.prefix ? `${e.tool}: ${e.prefix}` : e.tool;
}

/** Set difference in both directions — what a remote list would widen and narrow. */
export function diffAllowlists(
  local: GuardAllowEntry[],
  remote: GuardAllowEntry[],
): { added: GuardAllowEntry[]; removed: GuardAllowEntry[] } {
  return {
    added: remote.filter((r) => !local.some((l) => sameAllowEntry(l, r))),
    removed: local.filter((l) => !remote.some((r) => sameAllowEntry(r, l))),
  };
}

// ---------------------------------------------------------------------------
// MCP connections
// ---------------------------------------------------------------------------

export type McpTransport = 'http' | 'sse' | 'stdio';

/**
 * A third-party MCP server the user added from Settings, spliced into every
 * session's query options.
 *
 * `headerKeys` carries header *names* only. Values are credentials (a personal
 * access token is exactly what a header on an HTTP MCP server is for), so they
 * live in a local-only file on the bridge and never reach this shape — which is
 * the shape that is synced to storage and broadcast to browsers. The UI writes a
 * value and never reads one back, like a password field.
 */
export interface McpConnection {
  id: string;
  /** The MCP namespace: tools arrive as `mcp__<name>__<tool>`. */
  name: string;
  transport: McpTransport;
  /** http/sse only. */
  url?: string;
  /** stdio only. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Names of headers whose values are held locally; http/sse only. */
  headerKeys?: string[];
  /** Per-server tool-call timeout in ms. */
  timeout?: number;
  /** Off keeps the row but ships no tool definitions into any session. */
  enabled: boolean;
}

/** Header values for one connection, keyed by header name. Never synced, never broadcast. */
export type McpConnectionSecrets = Record<string, Record<string, string>>;

/** The synced form. `updatedAt` only orders writes at the storage row —
 *  divergence detection is a set difference, never a timestamp comparison. */
export interface McpConnectionsBlob {
  connections: McpConnection[];
  updatedAt: number;
}

/** A remote list awaiting explicit accept/reject. `connections` is what accept installs verbatim. */
export interface McpConnectionsReview {
  connections: McpConnection[];
  /** In remote, not local — would be added or changed. */
  added: McpConnection[];
  /** In local, not remote — would be removed or replaced. */
  removed: McpConnection[];
  /** ms epoch the divergence was first staged; a stable client dedupe key. */
  detectedAt: number;
}

export type McpConnectionError =
  | 'empty-name'
  | 'bad-name'
  | 'reserved-name'
  | 'bad-transport'
  | 'bad-url'
  | 'empty-command'
  | 'bad-header-name'
  | 'too-many-headers'
  | 'bad-timeout';

/**
 * Server names a user connection may not take. `lines` is the in-process
 * workflow-tools server (`LINES_MCP_SERVER` in server/src/mcpWorkflowTools.ts);
 * a connection under that name would shadow every `mcp__lines__*` tool.
 *
 * Duplicated here rather than imported because that module lives on the bridge
 * and pulls the whole bridge graph in with it. `mcpConnections.test.ts` asserts
 * the two agree, so the copy cannot drift.
 */
export const RESERVED_MCP_SERVER_NAMES = ['lines'];

/** MCP namespaces are used verbatim in tool names, so the charset is narrow. */
const MCP_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const MCP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MCP_HEADER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MCP_HEADERS_MAX = 10;
const MCP_TIMEOUT_MIN = 1000;
const MCP_TIMEOUT_MAX = 600_000;

/** Cap on the stored list, shared by the add gate and the storage route. */
export const MCP_CONNECTIONS_MAX = 50;

/** Unvalidated connection as it arrives from a form, disk, or a storage row. */
export type McpConnectionInput = {
  id?: string;
  name?: unknown;
  transport?: unknown;
  url?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  headerKeys?: unknown;
  timeout?: unknown;
  enabled?: unknown;
};

function randomConnectionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function stringMap(raw: unknown, keyRe?: RegExp): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    if (keyRe && !keyRe.test(k)) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Canonical form of a connection, or why it was refused. The single gate every
 * writer runs through — the Settings form, the wire handler, the load migration
 * and remote ingest — so a hand-typed row can never reach the SDK in a shape it
 * cannot build a server from. Mints an id when the input has none, which is how
 * the add path and the client's pre-send check share one function.
 */
export function normalizeConnection(
  raw: McpConnectionInput,
): { connection: McpConnection } | { error: McpConnectionError } {
  const src = (raw ?? {}) as McpConnectionInput;
  const name = (typeof src.name === 'string' ? src.name : '').trim().toLowerCase();
  if (!name) return { error: 'empty-name' };
  if (!MCP_NAME_RE.test(name)) return { error: 'bad-name' };
  if (RESERVED_MCP_SERVER_NAMES.includes(name)) return { error: 'reserved-name' };

  const transport = src.transport;
  if (transport !== 'http' && transport !== 'sse' && transport !== 'stdio') {
    return { error: 'bad-transport' };
  }

  const id = typeof src.id === 'string' && MCP_ID_RE.test(src.id) ? src.id : randomConnectionId();
  const connection: McpConnection = { id, name, transport, enabled: src.enabled !== false };

  if (typeof src.timeout === 'number' && Number.isFinite(src.timeout)) {
    if (src.timeout < MCP_TIMEOUT_MIN || src.timeout > MCP_TIMEOUT_MAX) return { error: 'bad-timeout' };
    connection.timeout = Math.round(src.timeout);
  }

  if (transport === 'stdio') {
    const command = (typeof src.command === 'string' ? src.command : '').trim();
    if (!command) return { error: 'empty-command' };
    connection.command = command;
    if (Array.isArray(src.args)) {
      const args = src.args.filter((a): a is string => typeof a === 'string');
      if (args.length) connection.args = args;
    }
    const env = stringMap(src.env);
    if (env) connection.env = env;
    return { connection };
  }

  const url = (typeof src.url === 'string' ? src.url : '').trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'bad-url' };
  }
  // Only the two schemes the SDK's HTTP/SSE transports can speak. A `file:` or
  // `javascript:` URL here would be a config that can never connect at best.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: 'bad-url' };
  connection.url = parsed.toString();

  if (Array.isArray(src.headerKeys)) {
    const keys: string[] = [];
    for (const raw of src.headerKeys) {
      if (typeof raw !== 'string') continue;
      const key = raw.trim();
      if (!key) continue;
      if (!MCP_HEADER_RE.test(key)) return { error: 'bad-header-name' };
      if (!keys.includes(key)) keys.push(key);
    }
    if (keys.length > MCP_HEADERS_MAX) return { error: 'too-many-headers' };
    if (keys.length) connection.headerKeys = keys;
  }
  return { connection };
}

/**
 * Content equality, ignoring key order — the only comparison divergence
 * detection uses. Ids are minted once and travel with the row, so an edited
 * connection is a remove plus an add in the diff, exactly as a re-typed guard
 * entry is.
 */
export function sameConnection(a: McpConnection, b: McpConnection): boolean {
  const key = (c: McpConnection) =>
    JSON.stringify([
      c.id,
      c.name,
      c.transport,
      c.url ?? '',
      c.command ?? '',
      c.args ?? [],
      Object.entries(c.env ?? {}).sort(),
      [...(c.headerKeys ?? [])].sort(),
      c.timeout ?? 0,
      c.enabled,
    ]);
  return key(a) === key(b);
}

/** Human-readable row label, e.g. "figma · https://mcp.figma.com/mcp". */
export function describeConnection(c: McpConnection): string {
  return `${c.name} · ${c.transport === 'stdio' ? (c.command ?? '') : (c.url ?? '')}`;
}

/** Set difference in both directions — what a remote list would add and drop. */
export function diffConnections(
  local: McpConnection[],
  remote: McpConnection[],
): { added: McpConnection[]; removed: McpConnection[] } {
  return {
    added: remote.filter((r) => !local.some((l) => sameConnection(l, r))),
    removed: local.filter((l) => !remote.some((r) => sameConnection(r, l))),
  };
}

/**
 * One MCP server's connection state, as the SDK reports it. A trimmed
 * `McpServerStatus`: `serverInfo` and per-tool annotations are dropped, and
 * `tools` becomes names only — everything the Settings pane actually renders.
 */
export interface McpServerStatusInfo {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  error?: string;
  scope?: string;
  tools?: string[];
}

/**
 * An MCP server asking the user for something mid-turn. Only `mode: 'url'` is
 * rendered — that is the SDK's supported OAuth path, where the CLI owns the
 * token exchange and all Lines does is show the link and report accept/decline.
 * A `form` request is declined on the bridge and never reaches a card.
 */
export interface McpElicitation {
  serverName: string;
  message: string;
  mode: 'url';
  url: string;
}

/**
 * How much a proposed MCP server endpoint can be trusted, as assessed on the
 * bridge (see server/src/mcpVetting.ts) before the approval card is raised.
 *
 * Exists because an agent-proposed URL can come from a page the agent read, so
 * the user needs something to judge besides the domain string. Deliberately a
 * check and not a verdict: `known` changes the card's colour and copy and
 * nothing else — the decision is always the user's.
 */
export interface McpVetting {
  level: 'known' | 'unknown' | 'suspicious';
  /** One line, shown under the badge. */
  reason: string;
  /** Where the agent said it found the endpoint (a documentation URL). */
  source?: string;
}

export type ServerMessage =
  /** `bridge` is optional: once the web app is hosted it will meet bridges older
   *  than itself, and an absent field is exactly that case. */
  | {
      type: 'hello';
      bridge?: BridgeInfo;
      /**
       * The user id this bridge stamps its own writes with — the socket's
       * authenticated identity, which is `local` with bridge auth off. Owner
       * connections only (a guest is told nothing account-wide), and the client
       * prefers it over its Clerk id so the two sides cannot disagree about who
       * owns a step. */
      userId?: string;
      sessions: SessionMeta[];
      workflows: WorkflowDef[];
      sharedWorkflows: WorkflowDef[];
      steps: StepDef[];
      sharedSteps: StepDef[];
      pinnedSteps: StepDef[];
      recipes: RecipeDef[];
      sharedRecipes: RecipeDef[];
      recipeStats: Record<string, number>;
      models: ModelOption[];
      recentDirs: string[];
      projects: Project[];
      projectKeys: ProjectKeyMap;
      usage: UsageSnapshot | null;
      auth: AuthStatus;
      storage: StorageStatus;
      worker?: WorkerStatus;
      /**
       * Desktop update state, so a browser opened *after* detection learns about
       * it — `updateStatus` is only pushed on a transition. Owner connections
       * only: a guest must not be nagged to update somebody else's machine.
       */
      update?: UpdateStatus;
      settings?: UserUiSettings | null;
      guardAllowlist?: GuardAllowEntry[];
      guardAllowlistReview?: GuardAllowlistReview | null;
      mcpConnections?: McpConnection[];
      mcpConnectionsReview?: McpConnectionsReview | null;
      /**
       * Present only on a guest connection, and the client's cue that this is
       * somebody else's machine: what it may do, and whose it is. Absent means
       * the owner's own connection, where everything above is fully populated.
       */
       access?: { scope: ShareScope; caps: ShareCaps; sessionIds?: string[]; ownerProfile: ShareProfile | null; deviceId: string | null };
    }
  | { type: 'projectKeys'; projectKeys: ProjectKeyMap }
  | { type: 'settings'; settings: UserUiSettings }
  /** The whole auto-mode guard allowlist after any change (card, UI edit, accepted review). */
  | { type: 'guardAllowlist'; entries: GuardAllowEntry[] }
  /** A remote allowlist awaiting the user's accept/reject; null once resolved. */
  | { type: 'guardAllowlistReview'; review: GuardAllowlistReview | null }
  /** The whole MCP connection list after any change. Header *values* are never in it. */
  | { type: 'mcpConnections'; connections: McpConnection[] }
  /** A remote connection list awaiting the user's accept/reject; null once resolved. */
  | { type: 'mcpConnectionsReview'; review: McpConnectionsReview | null }
  /**
   * How each MCP server is doing in one session. Session-bearing so the scoped
   * fan-out delivers it to that session's viewers; `servers` is last-known when
   * no query is live, since the detailed read needs one.
   */
  | { type: 'mcpServerStatus'; sessionId: string; servers: McpServerStatusInfo[] }
  /**
   * The same readings for several sessions at once, after a connection edit was
   * pushed onto every live query.
   *
   * Deliberately keyed by session id inside the payload rather than sent as N
   * `mcpServerStatus` messages: carrying a top-level `sessionId` would make
   * `sessionIdOf` classify it as session-scoped, and the fan-out would hand a
   * session guest the names, errors and statuses of the host's third-party
   * servers. With no `sessionId` field it is account-wide, which is owner-only —
   * the same reasoning that keeps `mcpConnections` account-wide.
   */
  | { type: 'mcpStatuses'; statuses: Record<string, McpServerStatusInfo[]> }
  /**
   * Answer to `authorizeMcpConnection`. Exactly one of the three optional fields
   * is set. `authUrl` is where the user must go; `alreadyAuthorized` means the
   * CLI already holds a token for this server, so there is nothing to visit —
   * a success, not the "no authorization URL" failure it would otherwise read as;
   * `error` means the handshake could not start, including the case where this
   * SDK build no longer exposes the (untyped) OAuth methods at all, which is why
   * the copy is server-supplied rather than a client-side string.
   */
  | {
      type: 'mcpAuthStarted';
      sessionId: string;
      name: string;
      authUrl?: string;
      alreadyAuthorized?: boolean;
      error?: string;
    }
  /** Fired once the browser redirect has been exchanged, with the resulting state. */
  | {
      type: 'mcpAuthCompleted';
      sessionId: string;
      name: string;
      ok: boolean;
      error?: string;
      servers?: McpServerStatusInfo[];
    }
  | { type: 'usage'; usage: UsageSnapshot | null }
  | { type: 'authStatus'; auth: AuthStatus }
  | { type: 'storageStatus'; storage: StorageStatus }
  /**
   * Who is watching one session. Session-bearing on purpose: the Phase 1 scoped
   * fan-out then delivers it to exactly that session's viewers and nobody else.
   */
  | { type: 'presence'; sessionId: string; viewers: PresenceViewer[] }
  /** Bridge->worker link health. No sessionId: one worker backs every session. */
  | { type: 'workerStatus'; worker: WorkerStatus }
  | { type: 'authLoginStarted'; authorizeUrl: string }
  | { type: 'authError'; message: string }
  | { type: 'projects'; projects: Project[] }
  | { type: 'sessionUpsert'; session: SessionMeta }
  | { type: 'sessionDeleted'; sessionId: string }
  | { type: 'workflows'; workflows: WorkflowDef[] }
  | { type: 'sharedWorkflows'; workflows: WorkflowDef[] }
  /** This user's own published steps (library heads). */
  | { type: 'steps'; steps: StepDef[] }
  /** Other users' published steps (library) plus any versions this user's workflows pin. */
  | { type: 'sharedSteps'; sharedSteps: StepDef[]; pinnedSteps: StepDef[] }
  /** Version history for one step, newest first. Echoes the request keys so the store can slot it. */
  | { type: 'stepVersions'; ownerId: string; stepId: string; versions: StepDef[] }
  /** This user's own recipe heads. */
  | { type: 'recipes'; recipes: RecipeDef[] }
  /** Other users' published recipe heads — the browsable corpus. */
  | { type: 'sharedRecipes'; sharedRecipes: RecipeDef[] }
  /** Version history for one recipe, newest first. Echoes the request keys. */
  | { type: 'recipeVersions'; ownerId: string; recipeId: string; versions: RecipeDef[] }
  /** Run counts keyed `ownerId/recipeId`. A PARTIAL map — merge it, never replace. */
  | { type: 'recipeStats'; stats: Record<string, number> }
  | { type: 'recipeImageUploaded'; uploadId: string; url: string }
  /** Answer to `runRecipe`, so the client can select the new session deterministically. */
  | { type: 'recipeRun'; runId: string; sessionId: string }
  /** `breakdown: null` = no live query or the control request failed — a state, not an error. */
  | { type: 'contextBreakdown'; sessionId: string; breakdown: ContextBreakdown | null }
  | { type: 'event'; sessionId: string; event: TranscriptEvent }
  | { type: 'transcript'; sessionId: string; events: TranscriptEvent[] }
  /**
   * Answer to a `rewindSession` that asked to edit, on the asking link only: the
   * rewound prompt, for the composer to prefill. The matching
   * `transcriptTruncated` goes to everyone, so a second tab drops the same tail
   * without also being handed the text.
   */
  | { type: 'rewound'; sessionId: string; seq: number; prompt: RewindPrompt }
  /** Everything at or after `seq` is gone from this session's transcript. */
  | { type: 'transcriptTruncated'; sessionId: string; seq: number }
  | { type: 'folderPicked'; path: string | null }
  | { type: 'error'; sessionId?: string; message: string }
  /** Reply to one fileRequest. `status` mirrors the HTTP codes the client already
   *  maps to messages (403/404/413/415); `body` is absent on failure. */
  | { type: 'fileResponse'; reqId: string; status: number; body?: unknown }
  | { type: 'updateStatus'; status: UpdateStatus }
  | { type: 'pong' };

/** Path fragment shared by both plan directories. Cheap hint only — the server's
 *  permission decisions go through autoGuard's `isPlanPath`, which anchors to the
 *  real directories. Lives here because the web transcript needs the same hint and
 *  cannot import from `server/`. */
export const PLAN_DIR_MARKER = '.claude/plans/';

/** True when a tool's raw file path points inside a plan directory. Separator-insensitive
 *  so Windows backslash paths match too (`path` is not importable in the browser). */
export function isPlanFilePath(filePath: string): boolean {
  return filePath.replace(/\\/g, '/').includes(PLAN_DIR_MARKER);
}

/**
 * The `parent_tool_use_id` of an SDK message, when it names one — i.e. the message
 * was produced by a subagent spawned by that `Task` call, not by the main agent.
 * Null for main-agent messages (outbound user messages carry an explicit null).
 */
export function subagentParentId(msg: unknown): string | null {
  const p = (msg as { parent_tool_use_id?: string | null } | null)?.parent_tool_use_id;
  return typeof p === 'string' && p ? p : null;
}

export const DEFAULT_MODELS: ModelOption[] = [
  { id: 'claude-opus-5', label: 'Opus 5', description: 'Powerful model for complex work', contextWindow: 1_000_000 },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', description: 'For demanding reasoning and long-horizon agentic work', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Balanced speed and capability', contextWindow: 1_000_000 },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest, for lightweight tasks', contextWindow: 200_000 },
];

export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Maps removed/retired model ids to their logical current replacement. Only
 * explicit, deliberate remaps belong here — unknown ids pass through unchanged
 * so valid dated snapshots (e.g. claude-haiku-4-5-20251001) are never downgraded.
 */
export const LEGACY_MODEL_MAP: Record<string, string> = {
  'claude-opus-4-8': 'claude-opus-5',
  'claude-fable-5': 'claude-fable-5-1',
};

/** True when `id` is one of the currently offered models. */
export function isKnownModel(id: string): boolean {
  return DEFAULT_MODELS.some((m) => m.id === id);
}

/** Known ids pass through; otherwise apply the legacy map, else return as-is. */
export function resolveModelId(id: string): string {
  if (isKnownModel(id)) return id;
  return LEGACY_MODEL_MAP[id] ?? id;
}

/**
 * Context window of `modelId` in tokens, or undefined when the model isn't
 * listed or carries no window. Callers must not guess a denominator from
 * undefined — show raw counts instead.
 */
export function contextWindowFor(modelId: string, models: ModelOption[]): number | undefined {
  const resolved = resolveModelId(modelId);
  return models.find((m) => m.id === resolved)?.contextWindow;
}

/**
 * True when the SDK breakdown should be rendered instead of the assistant-usage
 * fallback. Ties go to the summary: it is the source of truth, and both readings
 * are written at the same turn boundary.
 */
export function preferContextSummary(summary?: ContextSummary, usage?: ContextUsage): boolean {
  if (!summary) return false;
  return !usage || summary.at >= usage.at;
}

/**
 * Ring denominator. The SDK's own maxTokens wins whenever a breakdown exists —
 * it already accounts for 1M-context betas and the CLI's reserves, so mixing in
 * the hardcoded table would make our percentage disagree with `/context`.
 */
export function contextDenominator(
  summary: ContextSummary | undefined,
  modelId: string,
  models: ModelOption[],
): number | undefined {
  return summary?.maxTokens ?? contextWindowFor(modelId, models);
}

/** Percent of the window at which the UI starts warning about the context filling up. */
export const CONTEXT_WARN_PCT = 80;

/**
 * Tokens currently in context, from the freshest source available. A compaction
 * that landed *after* the last turn's reading wins: the readings describe the
 * conversation that was just summarized away, so without this the ring keeps
 * showing the pre-compaction number until the next turn reports — which is
 * exactly what a CLI auto-compaction does to us.
 *
 * `fromCompaction` tells the caller the number came from compact_metadata rather
 * than from a measured turn, so it can be labelled as such.
 */
export function effectiveContextTokens(
  meta: Pick<SessionMeta, 'contextSummary' | 'contextUsage' | 'contextCompact'>,
): { used: number; fromCompaction: boolean } | undefined {
  const { contextSummary: summary, contextUsage: usage, contextCompact: compact } = meta;
  const base = preferContextSummary(summary, usage)
    ? { used: summary!.totalTokens, at: summary!.at }
    : usage
      ? {
          used:
            usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens + usage.outputTokens,
          at: usage.at,
        }
      : undefined;
  if (compact?.ok && compact.postTokens != null && (!base || compact.at > base.at)) {
    return { used: compact.postTokens, fromCompaction: true };
  }
  return base ? { used: base.used, fromCompaction: false } : undefined;
}

export type ContextCompactBlockCode =
  | 'turn-running'
  | 'step-advancing'
  | 'no-session'
  | 'no-reading'
  | 'unsupported';

/** Why compaction can't run right now — `reason` goes straight into a tooltip. */
export interface ContextCompactBlockInfo {
  code: ContextCompactBlockCode;
  reason: string;
}

const NOTHING_TO_COMPACT = "Send a message first — there's nothing to compact yet.";

/**
 * The single predicate behind the manual-compaction gate: the server guard, the
 * Compact now button's `disabled`, and its tooltip all read this, so a disabled
 * button can always say *why*. Returns null when compaction is allowed.
 *
 * Order is transient-first: a session that is merely busy shouldn't be reported
 * as permanently unsupported.
 */
export function contextCompactBlock(
  meta: Pick<
    SessionMeta,
    'status' | 'claudeSessionId' | 'contextSummary' | 'contextUsage' | 'contextCompact' | 'workflow'
  >,
): ContextCompactBlockInfo | null {
  if (meta.status === 'running' || meta.status === 'waiting-permission') {
    return { code: 'turn-running', reason: 'Finish the current turn first.' };
  }
  // A step parked at waiting-approval compacts fine: every hand-off reads the
  // on-disk transcript (withoutCompactSpans), never the CLI's live context, and the
  // park is put back when the compaction settles (see sessions.compactContext). A
  // *live advance* is the real conflict — it is consolidating the step's output and
  // is about to prompt the next step, which a compaction would race.
  if (meta.workflow?.advancing) {
    return {
      code: 'step-advancing',
      reason: "This step's output is being wrapped up — try again in a moment.",
    };
  }
  // worker.push creates the query lazily, so '/compact' on a session that never
  // ran would spawn a fresh query with `resume: undefined` and compact nothing.
  if (!meta.claudeSessionId) return { code: 'no-session', reason: NOTHING_TO_COMPACT };
  if (!effectiveContextTokens(meta)) return { code: 'no-reading', reason: NOTHING_TO_COMPACT };
  if (meta.contextCompact?.ok === false) {
    const why = meta.contextCompact.error;
    return {
      code: 'unsupported',
      reason: why
        ? `Compaction isn't available in this session — ${why}`
        : "Compaction isn't available in this session.",
    };
  }
  return null;
}

/** Server-side guard form of {@link contextCompactBlock}. */
export function canCompactContext(
  meta: Parameters<typeof contextCompactBlock>[0],
): boolean {
  return contextCompactBlock(meta) === null;
}

/**
 * The prompt a rewind hands back for the composer to prefill. Attachments are
 * rehydrated from disk exactly as a retry rehydrates them.
 *
 * `mentions` is display metadata carried for completeness — `text` is already
 * the expanded form that was sent, so the composer restores text and
 * attachments only and cannot rebuild the inline pill ranges from it.
 */
export interface RewindPrompt {
  text: string;
  mentions?: PromptMention[];
  attachments: PromptAttachment[];
}

export type RewindBlockCode = 'turn-running' | 'no-session' | 'no-message' | 'fork-failed';

/** Why a rewind can't run — `reason` goes straight into a tooltip or an error toast. */
export interface RewindBlockInfo {
  code: RewindBlockCode;
  reason: string;
}

/**
 * The single predicate behind the rewind gate, in the same shape as
 * {@link contextCompactBlock}: the server guard, the transcript affordance's
 * `disabled` and its tooltip all read this. Returns null when a rewind is allowed.
 *
 * The two block codes it cannot decide from the meta alone — `no-message` (the
 * seq is not a `'user'` event) and `fork-failed` — are raised by the server.
 *
 * A started workflow is deliberately NOT a blocker: changing your mind halfway
 * through a workflow is a main reason to rewind. The engine rolls its own step
 * bookkeeping back to whatever the truncated transcript still shows
 * (WorkflowEngine.rollbackToTranscript) and parks the session on that step.
 */
export function rewindBlock(
  meta: Pick<SessionMeta, 'status' | 'claudeSessionId' | 'workflow'>,
): RewindBlockInfo | null {
  // Only a *live* turn, exactly as contextCompactBlock decides it. Deliberately
  // not isSessionActive, which also folds in 'waiting-approval': a session parked
  // for approval has already settled its turn, and reporting it as "finish the
  // current turn first" made the affordance look permanently broken.
  if (meta.status === 'running' || meta.status === 'waiting-permission') {
    return { code: 'turn-running', reason: 'Finish the current turn first.' };
  }
  // worker.push creates the query lazily, so there is no CLI conversation to
  // re-point at a truncated history until a turn has actually run.
  if (!meta.claudeSessionId) {
    return { code: 'no-session', reason: "Send a message first — there's nothing to rewind yet." };
  }
  return null;
}

/**
 * Per-model spend helpers, re-exported so callers get them alongside
 * `ModelSpendMap`. Safe above the cycle-sensitive block below: `usageByModel.ts`
 * imports only types from here, so nothing of ours is read at its top level.
 */
export { addSpend, mergeSpend, sortedSpend } from './usageByModel.ts';

/**
 * Timestamp display, re-exported for the same reason: it formats the
 * `createdAt`/`updatedAt` fields declared here. Safe above the cycle-sensitive
 * block below — `formatTime.ts` imports nothing at all.
 */
export { formatTimestamp } from './formatTime.ts';

/**
 * Workflow/step validation, re-exported so a caller gets the rules from the same
 * module as the types they validate.
 *
 * MUST STAY THE LAST STATEMENT IN THIS FILE. `./workflowValidation.ts` imports
 * back from here, so the two form a cycle, and it is only safe because (1) that
 * module reads our bindings inside function bodies only, never at its own top
 * level, and (2) this re-export runs after every other top-level binding here is
 * initialized. Moving it up, or hoisting a top-level read over there, brings back
 * a TDZ failure that shows up only for whichever module happens to be imported
 * first.
 */
export {
  formatWorkflowIssues,
  MAX_WORKFLOW_NAME_LEN,
  OUTPUT_NAME_HINT,
  OUTPUT_NAME_RE,
  validateStepContent,
  validateWorkflow,
  type StepForValidation,
  type ValidateOptions,
  type WorkflowIssue,
  type WorkflowIssueField,
} from './workflowValidation.ts';
