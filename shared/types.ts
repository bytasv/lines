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

/** A prompt sent while the session was busy; held server-side and flushed after the current turn. */
export interface QueuedPrompt {
  id: string;
  ts: number;
  text: string;
  /** Staged attachment refs; the server re-reads the files back to base64 at flush time. */
  attachments?: Attachment[];
}

export interface CavemanConfig {
  enabled: boolean;
  level: CavemanLevel;
}

export interface WorkflowStep {
  name: string;
  promptTemplate: string;
  model: string;
  permissionMode: PermissionMode;
  autoAdvance: boolean;
}

export interface WorkflowDef {
  id: string;
  name: string;
  steps: WorkflowStep[];
}

export type WorkflowStepStatus = 'pending' | 'running' | 'waiting-approval' | 'done';

export interface WorkflowState {
  workflowId: string;
  stepIndex: number;
  stepStatuses: WorkflowStepStatus[];
  /** The user's task description, captured from the first prompt; substituted into step templates as {task}. */
  task?: string;
  started: boolean;
  /** Set when a plan is approved mid-step: advance to the next step once the current turn ends. */
  advanceOnComplete?: boolean;
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
  errorMessage?: string;
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
  /** Prompts sent while busy, held for FIFO auto-send after each turn completes. */
  queued?: QueuedPrompt[];
  /** Interrupt/error/crash suspended auto-flush; the next user send resumes it. */
  queuePaused?: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
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
   */
  kind: 'user' | 'sdk' | 'file-snapshot' | 'permission' | 'workflow' | 'turn-summary';
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
  event: 'started' | 'waiting-approval' | 'approved' | 'retried' | 'workflow-done';
  feedback?: string;
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

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'createSession'; name: string; cwd: string; model: string; permissionMode: PermissionMode; caveman: CavemanConfig; workflowId?: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'prompt'; sessionId: string; text: string; attachments?: PromptAttachment[] }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'retryTurn'; sessionId: string }
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
  | { type: 'workflowApprove'; sessionId: string }
  | { type: 'workflowRetry'; sessionId: string; feedback: string }
  | { type: 'saveWorkflow'; workflow: WorkflowDef }
  | { type: 'deleteWorkflow'; workflowId: string }
  | { type: 'loadTranscript'; sessionId: string }
  | { type: 'pickFolder' }
  | { type: 'openProject'; path: string }
  | { type: 'closeProject'; path: string }
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

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: 'hello'; sessions: SessionMeta[]; workflows: WorkflowDef[]; models: ModelOption[]; recentDirs: string[]; projects: string[]; usage: UsageSnapshot | null }
  | { type: 'usage'; usage: UsageSnapshot | null }
  | { type: 'projects'; projects: string[] }
  | { type: 'sessionUpsert'; session: SessionMeta }
  | { type: 'sessionDeleted'; sessionId: string }
  | { type: 'workflows'; workflows: WorkflowDef[] }
  | { type: 'event'; sessionId: string; event: TranscriptEvent }
  | { type: 'transcript'; sessionId: string; events: TranscriptEvent[] }
  | { type: 'folderPicked'; path: string | null }
  | { type: 'error'; sessionId?: string; message: string }
  | { type: 'pong' };

export const DEFAULT_MODELS: ModelOption[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

export const DEFAULT_MODEL = 'claude-opus-4-8';
