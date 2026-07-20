/**
 * 'auto' is UI-level: the SDK runs in acceptEdits underneath while the bridge
 * server auto-approves tool calls its guard considers safe and prompts only
 * for dangerous ones (a local replica of the CLI's auto mode).
 */
export type PermissionMode = 'default' | 'auto' | 'plan' | 'acceptEdits' | 'bypassPermissions';

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'waiting-permission'
  | 'waiting-approval'
  | 'error';

export type CavemanLevel = 'lite' | 'full' | 'ultra';

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
   */
  kind: 'user' | 'sdk' | 'file-snapshot' | 'permission' | 'workflow';
  data: unknown;
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

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'createSession'; name: string; cwd: string; model: string; permissionMode: PermissionMode; caveman: CavemanConfig; workflowId?: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'prompt'; sessionId: string; text: string }
  | { type: 'interrupt'; sessionId: string }
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
  | { type: 'closeProject'; path: string };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: 'hello'; sessions: SessionMeta[]; workflows: WorkflowDef[]; models: ModelOption[]; recentDirs: string[]; projects: string[] }
  | { type: 'projects'; projects: string[] }
  | { type: 'sessionUpsert'; session: SessionMeta }
  | { type: 'sessionDeleted'; sessionId: string }
  | { type: 'workflows'; workflows: WorkflowDef[] }
  | { type: 'event'; sessionId: string; event: TranscriptEvent }
  | { type: 'transcript'; sessionId: string; events: TranscriptEvent[] }
  | { type: 'folderPicked'; path: string | null }
  | { type: 'error'; sessionId?: string; message: string };

export const DEFAULT_MODELS: ModelOption[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

export const DEFAULT_MODEL = 'claude-opus-4-8';
