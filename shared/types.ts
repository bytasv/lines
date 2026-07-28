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

export type CavemanLevel = 'lite' | 'full' | 'ultra';

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

/** A prompt sent while the session was busy; held server-side and flushed after the current turn. */
export interface QueuedPrompt {
  id: string;
  ts: number;
  text: string;
  /** Staged attachment refs; the server re-reads the files back to base64 at flush time. */
  attachments?: Attachment[];
  /** Display-only @mention badges; the expansion is already baked into `text`. */
  mentions?: PromptMention[];
}

export interface CavemanConfig {
  enabled: boolean;
  level: CavemanLevel;
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
  /** Owner opted in to sharing this workflow with every other user on the instance. */
  published?: boolean;
  /** Clerk userId of the owner — authoritative, stamped server-side on save. */
  ownerId?: string;
  /** Display label for the owner (name→email), cosmetic, supplied by the client. */
  ownerName?: string;
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
  /** Working-tree snapshot taken when the workflow starts, so a fresh step's
   *  {diff} shows only what the workflow changed, not pre-existing dirty state. */
  diffBaseline?: { ref: string; untracked: string[] };
  /** Consolidated final output of the last-completed step; consumed as {previous}
   *  by the next fresh-start step. Falls back to lastAssistantText when absent. */
  lastStepOutput?: string;
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
  /** false = the request produced no compaction (see contextCompactBlock's
   *  `unsupported`), which permanently disables the manual button. */
  ok: boolean;
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

export interface SessionMeta {
  id: string;
  name: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  caveman: CavemanConfig;
  status: SessionStatus;
  createdAt: number;
  /** True until the name is either auto-generated from the first prompt or renamed by the user. */
  nameAuto?: boolean;
  claudeSessionId?: string;
  workflow?: WorkflowState;
  lastCostUsd?: number;
  totalCostUsd?: number;
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
   * - 'sdk'       : raw SDK message (assistant / system / result / stream_event ...)
   * - 'file-snapshot': pre-edit file content captured for a tool_use (for diffs)
   * - 'permission': permission request / resolution
   * - 'workflow'  : workflow step transition marker
   * - 'turn-summary': one-line summary of a completed turn's tool activity
   * - 'context-compact': context compaction requested / finished
   */
  kind: 'user' | 'sdk' | 'file-snapshot' | 'permission' | 'workflow' | 'turn-summary' | 'context-compact';
  data: unknown;
}

export interface TurnSummaryData {
  /** seq of the sdk 'result' event this summarizes. */
  resultSeq: number;
  summary: string;
}

export interface FileSnapshotData {
  toolUseId: string;
  toolName: string;
  filePath: string;
  /** File content before the edit; null if the file did not exist. */
  before: string | null;
}

export interface PermissionRequestData {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** 'expired' = the server no longer holds this request (restart/interrupt); re-prompt needed. */
  resolution?: 'allow' | 'deny' | 'expired';
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
}

/** Response body of the bridge's GET /file endpoint (clickable file-path preview). */
export interface FileContentResponse {
  content: string;
}

/** One entry in a directory listing from the bridge's GET /tree endpoint. */
export interface TreeEntry {
  name: string;
  type: 'file' | 'dir';
}

/** Response body of the bridge's GET /tree endpoint (project file tree). */
export interface TreeResponse {
  entries: TreeEntry[];
}

/** Response body of the bridge's GET /find endpoint (@mention file-name search). */
export interface FindResponse {
  /** Ranked matches, as paths relative to the searched root. */
  files: string[];
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'createSession'; name: string; cwd: string; model: string; permissionMode: PermissionMode; caveman: CavemanConfig; workflowId?: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'prompt'; sessionId: string; text: string; attachments?: PromptAttachment[]; mentions?: PromptMention[] }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'retryTurn'; sessionId: string }
  | { type: 'continueTurn'; sessionId: string }
  | { type: 'cancelQueued'; sessionId: string; queuedId: string }
  | { type: 'ackSession'; sessionId: string }
  | { type: 'archiveSession'; sessionId: string }
  | { type: 'unarchiveSession'; sessionId: string }
  | { type: 'completeSession'; sessionId: string }
  | { type: 'setModel'; sessionId: string; model: string }
  | { type: 'setPermissionMode'; sessionId: string; mode: PermissionMode }
  | { type: 'setCaveman'; sessionId: string; caveman: CavemanConfig }
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
    }
  | { type: 'workflowApprove'; sessionId: string; stepIndex: number }
  /** Mark the current step done from the stepper, whether it is parked or still running. */
  | { type: 'workflowForceAdvance'; sessionId: string; stepIndex: number }
  | { type: 'workflowRetry'; sessionId: string; stepIndex: number; feedback: string }
  | { type: 'saveWorkflow'; workflow: WorkflowDef; ownerName?: string }
  | { type: 'deleteWorkflow'; workflowId: string }
  /** Save or update a step. Content changes bump the version; `published` shares it instance-wide. Server stamps ownerId. */
  | { type: 'saveStep'; step: StepContent; stepId?: string; published: boolean; ownerName?: string }
  /** Remove a step from the library (existing pins keep resolving the immutable versions). */
  | { type: 'deleteStep'; stepId: string }
  /** Request the full version history of a step (for preview + re-pin). Keys are echoed back. */
  | { type: 'stepVersions'; ownerId: string; stepId: string }
  /** Live `/context` breakdown for one session (hover-triggered). Echoed back. */
  | { type: 'contextBreakdown'; sessionId: string }
  /** Compact this session's context now (manual compaction). */
  | { type: 'compactContext'; sessionId: string }
  | { type: 'loadTranscript'; sessionId: string }
  | { type: 'pickFolder' }
  | { type: 'openProject'; path: string }
  | { type: 'closeProject'; path: string }
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

/** Bridge -> storage-server link health. `available: false` = the storage server / Supabase is unreachable. */
export interface StorageStatus {
  available: boolean;
  /** Underlying error (Prisma/DB message or transport failure), when known. */
  reason?: string;
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

export type ServerMessage =
  | { type: 'hello'; sessions: SessionMeta[]; workflows: WorkflowDef[]; sharedWorkflows: WorkflowDef[]; steps: StepDef[]; sharedSteps: StepDef[]; pinnedSteps: StepDef[]; models: ModelOption[]; recentDirs: string[]; projects: string[]; projectKeys: ProjectKeyMap; usage: UsageSnapshot | null; auth: AuthStatus; storage: StorageStatus; settings?: UserUiSettings | null; guardAllowlist?: GuardAllowEntry[]; guardAllowlistReview?: GuardAllowlistReview | null }
  | { type: 'projectKeys'; projectKeys: ProjectKeyMap }
  | { type: 'settings'; settings: UserUiSettings }
  /** The whole auto-mode guard allowlist after any change (card, UI edit, accepted review). */
  | { type: 'guardAllowlist'; entries: GuardAllowEntry[] }
  /** A remote allowlist awaiting the user's accept/reject; null once resolved. */
  | { type: 'guardAllowlistReview'; review: GuardAllowlistReview | null }
  | { type: 'usage'; usage: UsageSnapshot | null }
  | { type: 'authStatus'; auth: AuthStatus }
  | { type: 'storageStatus'; storage: StorageStatus }
  | { type: 'authLoginStarted'; authorizeUrl: string }
  | { type: 'authError'; message: string }
  | { type: 'projects'; projects: string[] }
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
  /** `breakdown: null` = no live query or the control request failed — a state, not an error. */
  | { type: 'contextBreakdown'; sessionId: string; breakdown: ContextBreakdown | null }
  | { type: 'event'; sessionId: string; event: TranscriptEvent }
  | { type: 'transcript'; sessionId: string; events: TranscriptEvent[] }
  | { type: 'folderPicked'; path: string | null }
  | { type: 'error'; sessionId?: string; message: string }
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

export const DEFAULT_MODELS: ModelOption[] = [
  { id: 'claude-opus-5', label: 'Opus 5', description: 'Powerful model for complex work', contextWindow: 200_000 },
  { id: 'claude-fable-5', label: 'Fable 5', description: 'Most intelligent, Mythos-class tier', contextWindow: 200_000 },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Balanced speed and capability', contextWindow: 200_000 },
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
  | 'step-parked'
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
    'status' | 'claudeSessionId' | 'contextSummary' | 'contextUsage' | 'contextCompact'
  >,
): ContextCompactBlockInfo | null {
  if (meta.status === 'running' || meta.status === 'waiting-permission') {
    return { code: 'turn-running', reason: 'Finish the current turn first.' };
  }
  if (meta.status === 'waiting-approval') {
    return {
      code: 'step-parked',
      reason:
        'This workflow step is waiting for approval — approve or force-advance it first, then compact.',
    };
  }
  // worker.push creates the query lazily, so '/compact' on a session that never
  // ran would spawn a fresh query with `resume: undefined` and compact nothing.
  if (!meta.claudeSessionId) return { code: 'no-session', reason: NOTHING_TO_COMPACT };
  if (!effectiveContextTokens(meta)) return { code: 'no-reading', reason: NOTHING_TO_COMPACT };
  if (meta.contextCompact?.ok === false) {
    return { code: 'unsupported', reason: "Compaction isn't available in this session." };
  }
  return null;
}

/** Server-side guard form of {@link contextCompactBlock}. */
export function canCompactContext(
  meta: Parameters<typeof contextCompactBlock>[0],
): boolean {
  return contextCompactBlock(meta) === null;
}
