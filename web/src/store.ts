import { create } from 'zustand';
import type {
  AuthStatus,
  BridgeInfo,
  ContextBreakdown,
  GrepResponse,
  GuardAllowEntry,
  GuardAllowlistReview,
  McpConnection,
  McpConnectionInput,
  McpConnectionsReview,
  McpServerStatusInfo,
  MemoryReview,
  ModelOption,
  PermissionMode,
  PlanComment,
  Project,
  ProjectKeyMap,
  PromptAttachment,
  PresenceViewer,
  PromptMention,
  ReasoningEffort,
  RecipeDef,
  RewindPrompt,
  ServerMessage,
  SessionMeta,
  SessionSearchResponse,
  ShareCaps,
  ShareProfile,
  ShareScope,
  StepDef,
  StorageStatus,
  TranscriptEvent,
  ClaudeCliStatus,
  CodexCliStatus,
  WhisperModelDownload,
  WhisperStatus,
  UpdateStatus,
  SpendHistoryBlob,
  UsageSnapshot,
  UserUiSettings,
  WorkerStatus,
  WorkflowDef,
} from '@lines/shared';
import {
  APP_PROTOCOL_VERSION,
  DEFAULT_MODEL,
  isReasoningEffort,
  normalizePlanComments,
  resolveModelId,
  worktreePaths,
} from '@lines/shared';
import { send, sendToMachine, switchDevice } from './ws';
import {
  alertTarget,
  emptyMachine,
  emptyView,
  machineView,
  inProject,
  mergeMachineSessions,
  prunableDraftIds,
  sessionsOnMachine,
  shouldClaimSelection,
  type MachineSlice,
} from './lib/machines';

/**
 * The `access` block a guest's `hello` carries. Named here rather than inlined so
 * selectors below and the components that read them share one shape.
 */
export interface GuestAccess {
  scope: ShareScope;
  caps: ShareCaps;
  sessionIds?: string[];
  ownerProfile: ShareProfile | null;
  deviceId: string | null;
}
import type { AlertSound } from './lib/alerts';
import {
  countAttention,
  countRunning,
  loadAlertSound,
  loadAlertsEnabled,
  maybeAlert,
  persistAlertSound,
  persistAlertsEnabled,
  playSound,
  primeAudio,
  requestNotifyPermission,
  setBadge,
} from './lib/alerts';
import { setBridgeOwnerId } from './lib/clerk';
import { ensurePushSubscription, removePushSubscription } from './lib/push';
import { rememberDeviceId } from './lib/storage';
import { updateFavicon } from './lib/favicon';
import {
  compareSessions,
  SESSION_SORT_KEY,
  sessionRowMeta,
  type SessionSort,
} from './lib/format';
import type { MentionValue } from './lib/mentions';

const ACTIVE_PROJECT_KEY = 'lines.activeProject';
const NEW_SESSION_DEFAULTS_KEY = 'lines.newSessionDefaults';
const SIDEBAR_MODE_KEY = 'lines.sidebarMode';
const HIDE_IGNORED_KEY = 'lines.hideIgnored';
const OPEN_FILES_KEY = 'lines.openFiles';
const LAST_SESSION_BY_PROJECT_KEY = 'lines.lastSessionByProject';
const COMPACTION_LEVEL_KEY = 'lines.compactionLevel';
const TURN_SUMMARIES_ENABLED_KEY = 'lines.turnSummariesEnabled';
const AUTO_CONTINUE_KEY = 'lines.autoContinueInterrupted';
const PLAN_REJECT_WRITES_KEY = 'lines.planModeRejectWrites';
const COMPRESS_RESPONSES_KEY = 'lines.compressResponses';
const PLAN_REASONING_EFFORT_KEY = 'lines.planReasoningEffort';
const SMART_ROUTING_KEY = 'lines.smartRouting';
const DISMISSED_CHECKOUTS_KEY = 'lines.dismissedCheckouts';
const VOICE_LANGUAGE_KEY = 'lines.voiceLanguage';
const VOICE_TRANSLATE_KEY = 'lines.voiceTranslate';
const DRAFTS_KEY = 'lines.drafts';
const PLAN_COMMENTS_KEY = 'lines.planComments';

export type SidebarMode = 'sessions' | 'files';

/** What the sidebar search looks through: every session of the project, the
 *  selected session only, or the project's files. */
export type SidebarSearchScope = 'all' | 'session' | 'files';

/**
 * The sidebar search, open over the session list. `null` = closed, and the
 * sidebar shows its normal list. One query serves every scope, so flipping the
 * scope re-runs what was typed rather than starting over.
 */
export interface SidebarSearchState {
  query: string;
  scope: SidebarSearchScope;
  /** Session-scope results. File results live in `fileSearch`. */
  results: SessionSearchResponse | null;
  /** What `results` answered (query + scope + ids). Anything else on screen is
   *  stale — see searchKey. */
  resultsFor: string;
  loading: boolean;
  error: string | null;
}

/** The Files scope's match flags and results. Kept apart from the session
 *  results so switching scope back and forth shows each one's last answer. */
export interface FileSearchState {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
  results: GrepResponse | null;
  /** What `results` answered (query + roots + flags), like SidebarSearchState's. */
  resultsFor: string;
  loading: boolean;
  error: string | null;
}

/** A file-search hit shown in the main pane, beside the results that found it. */
export interface SearchPreview {
  path: string;
  line?: number;
  col?: number;
}

/** A session-search hit the transcript should scroll to and highlight. */
export interface TranscriptJump {
  sessionId: string;
  seq: number;
  toolUseId?: string;
  query: string;
  /** Bumped per click, so jumping to the same hit twice still scrolls. */
  nonce: number;
}

/** How aggressively the transcript folds agent activity. Persisted in localStorage. */
export type CompactionLevel = 'full' | 'grouped' | 'compact';

/** Browser<->bridge link health. 'offline' = navigator.onLine false; 'reconnecting' = socket down but network up. */
export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline';

/** A prompt held locally while the socket is down, auto-sent on reconnect (session-memory only, lost on reload). */
export interface QueuedPrompt {
  id: string;
  sessionId: string;
  text: string;
  attachments?: PromptAttachment[];
  /** Display-only @mention badges; the expansion is already baked into `text`. */
  mentions?: PromptMention[];
  queuedAt: number;
}

/** Open editor tabs for one project (files mode). */
export interface OpenFilesState {
  tabs: string[];
  active: string | null;
}

function loadSidebarMode(): SidebarMode {
  return localStorage.getItem(SIDEBAR_MODE_KEY) === 'files' ? 'files' : 'sessions';
}

/** On by default: `.env` and build output are noise until you ask for them. */
function loadHideIgnored(): boolean {
  return localStorage.getItem(HIDE_IGNORED_KEY) !== 'false';
}

function loadCompactionLevel(): CompactionLevel {
  const v = localStorage.getItem(COMPACTION_LEVEL_KEY);
  return v === 'full' || v === 'grouped' || v === 'compact' ? v : 'compact';
}

function loadTurnSummariesEnabled(): boolean {
  return localStorage.getItem(TURN_SUMMARIES_ENABLED_KEY) !== 'false';
}

/** On unless explicitly turned off, matching the bridge-side default. */
function loadAutoContinueInterrupted(): boolean {
  return localStorage.getItem(AUTO_CONTINUE_KEY) !== 'false';
}

/** Off unless explicitly turned on, matching the bridge-side default. */
function loadPlanModeRejectWrites(): boolean {
  return localStorage.getItem(PLAN_REJECT_WRITES_KEY) === 'true';
}

/** On unless explicitly turned off, matching the bridge-side default. */
function loadCompressResponses(): boolean {
  return localStorage.getItem(COMPRESS_RESPONSES_KEY) !== 'false';
}

function loadVoiceLanguage(): string {
  return localStorage.getItem(VOICE_LANGUAGE_KEY) ?? 'auto';
}

function loadOpenFiles(): Record<string, OpenFilesState> {
  try {
    const raw = localStorage.getItem(OPEN_FILES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, OpenFilesState>) : {};
  } catch {
    return {};
  }
}

function persistOpenFiles(openFiles: Record<string, OpenFilesState>) {
  localStorage.setItem(OPEN_FILES_KEY, JSON.stringify(openFiles));
}

/** Last session the user selected in each project, project path -> session id. */
function readLastSessions(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LAST_SESSION_BY_PROJECT_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * The sidebar's session sort, read from where its `useLocalStorage` keeps it
 * (a JSON string), so auto-selection lands on the row the sidebar shows first.
 */
function readSessionSort(): SessionSort {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_SORT_KEY) ?? 'null') as unknown;
    return raw === 'status' || raw === 'activity' || raw === 'created' ? raw : 'status';
  } catch {
    return 'status';
  }
}

function writeLastSession(projectPath: string, sessionId: string) {
  const last = readLastSessions();
  if (last[projectPath] === sessionId) return;
  last[projectPath] = sessionId;
  localStorage.setItem(LAST_SESSION_BY_PROJECT_KEY, JSON.stringify(last));
}

// ---------------------------------------------------------------------------
// Composer drafts — unsent prompt text (plus its @mention pills) per session, so
// a reload or a bridge restart never eats what the user was typing.
// ---------------------------------------------------------------------------

function loadDrafts(): Record<string, MentionValue> {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const out: Record<string, MentionValue> = {};
    for (const [id, v] of Object.entries(parsed)) {
      const d = v as Partial<MentionValue>;
      if (typeof d?.text === 'string') out[id] = { text: d.text, ranges: Array.isArray(d.ranges) ? d.ranges : [] };
    }
    return out;
  } catch {
    return {};
  }
}

/** The stored draft for a session, or an empty one. */
export function readDraft(sessionId: string): MentionValue {
  return loadDrafts()[sessionId] ?? { text: '', ranges: [] };
}

/** Persist a draft; an empty one is removed rather than stored. */
export function writeDraft(sessionId: string, value: MentionValue) {
  const drafts = loadDrafts();
  if (value.text) drafts[sessionId] = value;
  else delete drafts[sessionId];
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
}

/** Every session id with a stored draft, so the caller can decide which may go. */
function draftSessionIds(): string[] {
  return Object.keys(loadDrafts());
}

/**
 * Delete exactly the named drafts.
 *
 * Takes the ids to *remove*, not the ids to keep. It used to take the live set and
 * drop everything else, which is correct for one machine and destructive for two:
 * a draft belonging to a machine whose link is not open has no live session to
 * match, so an unscoped pass deletes text the user typed and never sent.
 */
function pruneDrafts(doomedSessionIds: Set<string>) {
  if (doomedSessionIds.size === 0) return;
  const drafts = loadDrafts();
  let changed = false;
  for (const id of doomedSessionIds) {
    if (drafts[id]) {
      delete drafts[id];
      changed = true;
    }
  }
  if (changed) localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
}

// ---------------------------------------------------------------------------
// Plan comments — notes the user attached to passages of a plan while reviewing
// it, before deciding. Persisted for the same reason composer drafts are: the
// plan card is unmounted and remounted freely (the transcript windows its tail),
// so component-local state would lose a half-finished review to a scroll.
//
// Keyed by session *and* requestId: a session can hold several plan rounds, and
// comments belong to the plan they were written against, never to the next one.
// ---------------------------------------------------------------------------

type PlanCommentStore = Record<string, Record<string, PlanComment[]>>;

function loadPlanComments(): PlanCommentStore {
  try {
    const raw = localStorage.getItem(PLAN_COMMENTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const out: PlanCommentStore = {};
    for (const [sessionId, byRequest] of Object.entries(parsed)) {
      if (!byRequest || typeof byRequest !== 'object') continue;
      for (const [requestId, list] of Object.entries(byRequest as Record<string, unknown>)) {
        // Same gate the server runs on the wire payload, so what is stored can
        // never be wider than what would survive being sent.
        const comments = normalizePlanComments(list);
        if (comments.length) (out[sessionId] ??= {})[requestId] = comments;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** The stored comments for one plan card, or an empty list. */
export function readPlanComments(sessionId: string, requestId: string): PlanComment[] {
  return loadPlanComments()[sessionId]?.[requestId] ?? [];
}

/** Persist a card's comments; an empty list removes the entry rather than storing it. */
export function writePlanComments(sessionId: string, requestId: string, comments: PlanComment[]) {
  const all = loadPlanComments();
  if (comments.length) (all[sessionId] ??= {})[requestId] = comments;
  else {
    delete all[sessionId]?.[requestId];
    if (all[sessionId] && Object.keys(all[sessionId]).length === 0) delete all[sessionId];
  }
  localStorage.setItem(PLAN_COMMENTS_KEY, JSON.stringify(all));
}

/** Delete exactly the named sessions' comments. Same rule as pruneDrafts. */
function prunePlanComments(doomedSessionIds: Set<string>) {
  if (doomedSessionIds.size === 0) return;
  const all = loadPlanComments();
  let changed = false;
  for (const id of doomedSessionIds) {
    if (all[id]) {
      delete all[id];
      changed = true;
    }
  }
  if (changed) localStorage.setItem(PLAN_COMMENTS_KEY, JSON.stringify(all));
}

// ---------------------------------------------------------------------------
// Draft attachments — staged but unsent files, per session. IndexedDB (not
// localStorage) because base64 file/image data routinely runs tens of MB,
// well past typical 5-10MB localStorage quotas.
// ---------------------------------------------------------------------------

const DRAFT_ATTACHMENTS_DB = 'lines-drafts';
const DRAFT_ATTACHMENTS_STORE = 'attachments';

function openDraftAttachmentsDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DRAFT_ATTACHMENTS_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DRAFT_ATTACHMENTS_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The staged attachments for a session, or none. */
export async function readDraftAttachments(sessionId: string): Promise<PromptAttachment[]> {
  try {
    const db = await openDraftAttachmentsDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_ATTACHMENTS_STORE, 'readonly');
      const req = tx.objectStore(DRAFT_ATTACHMENTS_STORE).get(sessionId);
      req.onsuccess = () => resolve((req.result as PromptAttachment[] | undefined) ?? []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

/** Persist staged attachments; an empty list deletes the entry rather than storing one. */
export async function writeDraftAttachments(sessionId: string, attachments: PromptAttachment[]): Promise<void> {
  try {
    const db = await openDraftAttachmentsDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DRAFT_ATTACHMENTS_STORE, 'readwrite');
      const store = tx.objectStore(DRAFT_ATTACHMENTS_STORE);
      if (attachments.length) store.put(attachments, sessionId);
      else store.delete(sessionId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort — losing a staged attachment on a write failure isn't fatal
  }
}

/** Delete exactly the named sessions' staged attachments. Same rule as pruneDrafts. */
async function pruneDraftAttachments(doomedSessionIds: Set<string>): Promise<void> {
  if (doomedSessionIds.size === 0) return;
  try {
    const db = await openDraftAttachmentsDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DRAFT_ATTACHMENTS_STORE, 'readwrite');
      const store = tx.objectStore(DRAFT_ATTACHMENTS_STORE);
      for (const id of doomedSessionIds) store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort
  }
}

export interface NewSessionDefaults {
  model: string;
  permissionMode: PermissionMode;
  /** Absent = new sessions run at the provider's own effort. */
  reasoningEffort?: ReasoningEffort;
}

function loadNewSessionDefaults(): NewSessionDefaults {
  const fallback: NewSessionDefaults = { model: DEFAULT_MODEL, permissionMode: 'auto' };
  try {
    const raw = localStorage.getItem(NEW_SESSION_DEFAULTS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      model: typeof parsed.model === 'string' ? resolveModelId(parsed.model) : fallback.model,
      // 'default' and 'acceptEdits' no longer have a segment, so a profile that
      // saved one would open Settings to an unselected row. Folded in here rather
      // than run as a migration: this is the only reader of the stored value.
      permissionMode:
        typeof parsed.permissionMode === 'string' &&
        parsed.permissionMode !== 'default' &&
        parsed.permissionMode !== 'acceptEdits'
          ? parsed.permissionMode
          : fallback.permissionMode,
      ...(isReasoningEffort(parsed.reasoningEffort)
        ? { reasoningEffort: parsed.reasoningEffort }
        : {}),
    };
  } catch {
    return fallback;
  }
}

/** Global plan-mode effort. Absent = plan turns run at the session's own effort. */
function loadPlanReasoningEffort(): ReasoningEffort | undefined {
  const raw = localStorage.getItem(PLAN_REASONING_EFFORT_KEY);
  return isReasoningEffort(raw) ? raw : undefined;
}

function loadSmartRouting(): UserUiSettings['smartRouting'] {
  try {
    const raw = localStorage.getItem(SMART_ROUTING_KEY);
    const parsed = raw ? (JSON.parse(raw) as UserUiSettings['smartRouting']) : undefined;
    return parsed && typeof parsed === 'object' && parsed.mode ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Selected session from the current URL, so a reload keeps its route. */
function sessionIdFromUrl(): string | null {
  const m = window.location.pathname.match(/^\/session\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function loadDismissedCheckouts(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_CHECKOUTS_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function pickActive(projects: Project[], current: string | null): string | null {
  if (current && projects.some((p) => p.path === current)) return current;
  return projects[0]?.path ?? null;
}

/**
 * Coerce a wire project list to `Project[]`. `hello` carries no protocol
 * version, so a tab left open across the upgrade — or an old bridge — would
 * otherwise feed bare path strings straight into the tab list and render
 * `[object Object]`.
 */
function toProjects(raw: (Project | string)[]): Project[] {
  return raw.map((p) => (typeof p === 'string' ? { path: p } : p));
}

/**
 * Cheap identity of the session/project half of a `hello`.
 *
 * Two *different* bridge states alternating (the flicker) produce two signatures;
 * one bridge announcing itself twice produces one, and the reducer can then leave
 * `sessions`, `transcriptLoaded` and `contextBreakdowns` alone. Deliberately not a
 * hash of the whole message: the volatile fields (usage, worker/storage health) are
 * applied on every `hello` regardless, so including them would defeat this.
 */
function helloSignature(sessions: SessionMeta[], projects: Project[]): string {
  const ids = sessions.map((s) => `${s.id}:${s.updatedAt ?? s.createdAt}`).join(',');
  return `${ids}|${projects.map((p) => p.path).join(',')}`;
}

/** `seen` plus `ids`, or `seen` itself when nothing is new — no pointless re-render. */
function withSeen(seen: Set<string>, ids: string[]): Set<string> {
  const fresh = ids.filter((id) => !seen.has(id));
  if (fresh.length === 0) return seen;
  const next = new Set(seen);
  for (const id of fresh) next.add(id);
  return next;
}

/** Owned machines whose bridge accepts push registration. */
function pushMachines(state: { machines: Record<string, MachineSlice> }): string[] {
  return Object.values(state.machines)
    .filter((m) => m.push)
    .map((m) => m.deviceId);
}

/**
 * Hand this device's push subscription to each machine. Every owned machine, not
 * only the primary: each bridge pushes for the sessions it hosts, the same
 * "not scoped to the machine in front of you" rule `maybeAlert` follows.
 */
async function registerPushWith(deviceIds: string[]): Promise<void> {
  if (!deviceIds.length) return;
  const reg = await ensurePushSubscription();
  if (!reg) return;
  for (const id of deviceIds) sendToMachine(id, { type: 'registerPush', ...reg });
}

/** Unsubscribe this device and tell the machines. One that is offline keeps the
 *  row until its next push is answered 410, which removes it there. */
async function unregisterPushFrom(deviceIds: string[]): Promise<void> {
  const endpoint = await removePushSubscription();
  if (!endpoint) return;
  for (const id of deviceIds) sendToMachine(id, { type: 'unregisterPush', endpoint });
}

/** The open project with this path, if any — what `sessionsInProject` wants. */
/**
 * Whether a device id is the machine the UI is on.
 *
 * A direct local bridge has no device id at all, so before anything is chosen the
 * empty key *is* the primary — otherwise a local install would never update the
 * scalars the banners read.
 */
function isPrimary(state: { primaryDeviceId: string | null }, deviceId: string): boolean {
  return deviceId === (state.primaryDeviceId ?? '');
}

export function projectAt(projects: Project[], path: string | null): Project | null {
  return path ? projects.find((p) => p.path === path) ?? null : null;
}

/**
 * Sessions that belong to the given project — every one of its roots, since a
 * session started in an extra root belongs to the tab that spans it.
 *
 * Matching is by project key when that checkout has one, so a session created
 * on another machine — where the same repo sits at a different absolute path —
 * still lands in this project. Unkeyed checkouts (no git remote) fall back to
 * exact path equality, which is the old behaviour.
 *
 * `projectPaths`, not `projectRoots`: a work-tree session belongs to this tab
 * (attribution) without the tab's sessions gaining any right to write there. A
 * keyed work tree already matched through the shared key; the path list is what
 * covers a repo with no origin, where there is no key to share.
 */
export function sessionsInProject(
  sessions: Record<string, SessionMeta>,
  projectKeys: ProjectKeyMap,
  project: Project | null,
): SessionMeta[] {
  if (!project) return [];
  return Object.values(sessions).filter((s) => inProject(s, projectKeys, project));
}

/**
 * Which actionable session states the user has already seen, session id -> the
 * `sessionRowMeta` label that was acknowledged. Drives the project tab dot: a
 * tab only pulses for states missing from this map.
 *
 * Two rules make "seen" mean what it should. Opening a project acknowledges
 * everything actionable in it — the sidebar spells those out, so they are seen
 * by definition. And an entry is dropped the moment its session stops being
 * actionable, so the same session needing the user *again* later reads as new
 * rather than staying silently acknowledged.
 *
 * Membership comes from `sessionsInProject` — the one sanctioned check — rather
 * than a second inline copy of the rules, so the tab dot cannot drift from what
 * the sidebar lists.
 */
function reconcileSeenStatus(
  seen: Record<string, string>,
  sessions: Record<string, SessionMeta>,
  projectKeys: ProjectKeyMap,
  activeProject: Project | null,
): Record<string, string> {
  const next: Record<string, string> = {};
  const inActive = new Set(
    sessionsInProject(sessions, projectKeys, activeProject).map((s) => s.id),
  );
  for (const s of Object.values(sessions)) {
    if (s.archived) continue;
    const { actionable, label } = sessionRowMeta(s);
    if (!actionable) continue; // no entry — a later relapse counts as unseen
    if (inActive.has(s.id) || seen[s.id] === label) next[s.id] = label;
  }
  return next;
}

function sameStringMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/**
 * Top row of the user's sidebar sort among the project's non-archived sessions,
 * if any.
 *
 * Archived sessions are skipped so auto-selection never lands on a row the
 * sidebar hides in its "Archived (N)" group. `completed` needs no separate
 * check — the server always archives alongside it (see `lib/format.ts`).
 */
function latestSessionIn(
  sessions: Record<string, SessionMeta>,
  projectKeys: ProjectKeyMap,
  project: Project,
): SessionMeta | undefined {
  return sessionsInProject(sessions, projectKeys, project)
    .filter((s) => !s.archived)
    .sort(compareSessions(readSessionSort()))[0];
}

/**
 * The project's last selected session, when it still belongs here and is not
 * archived — the same auto-selection rule `latestSessionIn` keeps. A stale entry
 * is left in place rather than pruned: the session may simply sit on a machine
 * whose `hello` has not landed yet, and the next selection overwrites it anyway.
 */
function rememberedSessionIn(
  sessions: Record<string, SessionMeta>,
  projectKeys: ProjectKeyMap,
  project: Project,
): SessionMeta | undefined {
  const id = readLastSessions()[project.path];
  if (!id) return undefined;
  return sessionsInProject(sessions, projectKeys, project).find((s) => s.id === id && !s.archived);
}

interface UiState {
  connectionStatus: ConnectionStatus;
  /**
   * Whether a `hello` has landed, i.e. whether this store holds a machine's real
   * state or just its initial emptiness. Distinct from `connectionStatus`: the
   * socket opens a beat before `hello` arrives, and rendering the app in that gap
   * shows a fully-built UI containing nothing, which reads as data loss.
   *
   * Sticky once true — a reconnect must not blank the app, because the cached
   * state is still the right thing to show while the link comes back.
   */
  bootstrapped: boolean;
  /**
   * Present only when this browser is talking to somebody else's machine: what
   * we may do there, and whose it is. Null on your own machine.
   *
   * The UI narrows from this and the shared `MESSAGE_AUTHZ`/caps table rather
   * than from hand-written conditionals, so a capability the bridge would refuse
   * is not offered in the first place.
   */
  access: GuestAccess | null;
  /**
   * Who else is watching each session, keyed by session id. Ephemeral: the bridge
   * holds it in memory and re-sends on every change, so there is nothing to
   * reconcile or persist here.
   */
  presence: Record<string, PresenceViewer[]>;
  /**
   * Per-machine state, keyed by device id ('' for a direct local bridge).
   *
   * `connectionStatus`, `machineOffline`, `bootstrapped`, `workerStatus` and
   * `storageStatus` are kept as scalars *derived from the primary machine* rather
   * than replaced: ConnectionBanner/WorkerBanner/StorageBanner have a documented
   * "exactly one renders at a time" precedence, and making them per-machine-aware
   * wholesale would rewrite that rule mid-flight. A non-primary machine's health
   * belongs on the session row and header instead.
   */
  machines: Record<string, MachineSlice>;
  /** The machine the UI is on; null before one is chosen. */
  primaryDeviceId: string | null;
  /**
   * Which machine hosts each session, stamped by the reducer from the link a
   * frame arrived on.
   *
   * Deliberately not a field on SessionMeta: that blob syncs to Postgres, and
   * which machine a session is running on is not a property of its persisted
   * metadata — it is a property of this client's current connections.
   */
  sessionMachine: Record<string, string>;
  /**
   * Everyone this client has learned a name for, by user id.
   *
   * The third source of display identity, alongside Clerk (for yourself) and
   * `access.ownerProfile` (for the host). Fed by presence, whose viewer entries
   * carry server-attested profiles — which is what lets a *historical* prompt
   * whose recorded actor has no name render correctly as soon as that person is
   * seen in the session. Grows only; a name once learned is never unlearned.
   */
  profiles: Record<string, ShareProfile>;
  /**
   * The relay says no bridge is attached for this machine — it is asleep, off, or
   * not running Lines. Distinct from a failed socket: the socket is fine, the
   * machine behind it is not, and waiting cannot fix that. It is what lets the
   * connecting screen state the problem instead of guessing after six seconds.
   */
  machineOffline: boolean;
  /**
   * A control message the socket could not carry (delete, archive, …). Surfaced
   * because a dropped one used to be a `console.warn` and nothing else, which is
   * how "delete did nothing" stayed invisible.
   */
  actionError: string | null;
  /**
   * Fingerprint of the last applied `hello` payload. A repeated `hello` — which the
   * relay produces whenever it replays a channel `open` to a (re)attaching bridge —
   * carries the same one, and applying it again is what replaced `sessions`
   * wholesale and blanked the transcript cache on a loop.
   */
  helloSignature: string | null;
  /**
   * Every session id this browser has been told about. A session that leaves the
   * map and comes back (a sync round-trip, a duplicate snapshot) must never look
   * new again, or it steals the selection from the one the user is looking at.
   */
  seenSessionIds: Set<string>;
  /**
   * The user asked for a session and its upsert has not arrived yet. Auto-select is
   * gated on this rather than on `createdAt`: that timestamp is stamped on the
   * *bridge* machine, so hosted the comparison was against a foreign clock.
   */
  pendingCreate: boolean;
  /**
   * The session a `pendingCreate` just handed the selection to, waiting for its
   * composer to take focus (see takeComposerFocus). Same create intent, so the
   * composer no longer guesses "new" from `createdAt` either.
   */
  focusComposerFor: string | null;
  /** Prompts waiting for the socket to come back, flushed FIFO after the next `hello`. */
  queuedPrompts: QueuedPrompt[];
  sessions: Record<string, SessionMeta>;
  workflows: WorkflowDef[];
  /** Other users' published workflows — read-only, runnable/duplicable but not editable. */
  sharedWorkflows: WorkflowDef[];
  /** This user's own published steps (library heads). */
  steps: StepDef[];
  /** Other users' published steps — the library to compose from. */
  sharedSteps: StepDef[];
  /** Exact immutable step versions this user's workflows pin (for display/diff). */
  pinnedSteps: StepDef[];
  /** Fetched version histories, keyed `${ownerId}/${stepId}`; populated on demand per popover open. */
  stepVersions: Record<string, StepDef[]>;
  /** This user's own recipe heads (published or not). */
  recipes: RecipeDef[];
  /** Other users' published recipes — the browsable corpus. */
  sharedRecipes: RecipeDef[];
  /** Fetched recipe histories, keyed `${ownerId}/${recipeId}`; populated per popover open. */
  recipeVersions: Record<string, RecipeDef[]>;
  /** Public run counts keyed `${ownerId}/${recipeId}`. Server pushes partial maps, so this only ever grows/merges. */
  recipeStats: Record<string, number>;
  /** In-flight recipe screenshot uploads by uploadId, resolved to a `url` or an `error`. */
  recipeUploads: Record<string, { name: string; url?: string; error?: string }>;
  models: ModelOption[];
  recentDirs: string[];
  /** Open projects, shown as tabs. Each spans a primary path plus any extra roots. */
  projects: Project[];
  /** cwd -> machine-independent project identity; see ProjectKeyMap. */
  projectKeys: ProjectKeyMap;
  /** Unresolvable cwds the user marked as "not my project"; hidden from the link hint. */
  dismissedCheckouts: string[];
  /** Project whose sessions are shown; new sessions run here. */
  activeProject: string | null;
  /** Actionable session states the user has already looked at; see reconcileSeenStatus. */
  seenSessionStatus: Record<string, string>;
  transcripts: Record<string, TranscriptEvent[]>;
  /** Sessions whose on-disk transcript has been requested/loaded. */
  transcriptLoaded: Record<string, boolean>;
  /** ms epoch of the last event seen per session (not persisted) — wedged-agent detection. */
  lastEventAt: Record<string, number>;
  /** Prompt a rewind handed back, waiting for that session's composer to pick it
   *  up (see takeComposerPrefill). Only ever set on the tab that asked. */
  composerPrefill: Record<string, RewindPrompt>;
  /** Live `/context` breakdown per session from the last hover fetch. Ephemeral:
   *  the detail is only meaningful while the session has a live query. */
  contextBreakdowns: Record<string, { breakdown: ContextBreakdown | null; at: number; loading: boolean }>;
  selectedSessionId: string | null;
  folderPickPending: boolean;
  /**
   * Project the in-flight folder pick adds a root to; null means the pick opens a
   * new project. `folderPicked` is answered only on the socket that asked, so the
   * intent can live here instead of on the wire.
   */
  folderPickTarget: string | null;
  /**
   * A `createSession` whose work tree is still being checked out. `worktree add`
   * on a big repo can outlive `CREATE_INTENT_TTL_MS`, so the flag both disables the
   * button (a second click would cut a second work tree) and re-arms the create
   * intent when the `projects` broadcast shows the new path.
   */
  worktreePending: boolean;
  /** Model/mode applied to newly created sessions; persisted in localStorage. */
  newSessionDefaults: NewSessionDefaults;
  /** Play a chime + desktop notification when a session finishes or needs input. */
  alertsEnabled: boolean;
  alertSound: AlertSound;
  notifyPermission: NotificationPermission;
  /** File the preview modal is showing; null when closed. */
  filePreview: { path: string; display: string; line?: number; col?: number; raw?: boolean } | null;
  /** Claude-plan usage snapshot from the bridge; null when unavailable (API-key users). */
  usage: UsageSnapshot | null;
  /** ChatGPT-plan usage snapshot; null when no OpenAI account is connected, or
   *  when codex's access token is stale and the reading could not be taken. */
  openaiUsage: UsageSnapshot | null;
  /** The primary machine's day-resolution spend ledger; null until the first
   *  `hello` from it, and on a bridge too old to send one. Machine-local by
   *  construction — see `SpendHistoryBlob`. */
  spendHistory: SpendHistoryBlob | null;
  /** App login state from the bridge; null until the first `hello`. */
  auth: AuthStatus | null;
  /** Bridge->storage/Supabase link health; null until first `hello`. `available: false` shows the sync-degraded banner. */
  storageStatus: StorageStatus | null;
  /** Bridge->worker link health; null until first `hello`, and on a bridge too
   *  old to send it. `connected: false` shows the worker banner. */
  workerStatus: WorkerStatus | null;
  /** Desktop update the primary machine is offering; null until the first `hello`.
   *  `state: 'available'` shows the update banner. */
  updateStatus: UpdateStatus | null;
  /** Which bridge we're talking to; null until the first hello, and on a bridge
   *  too old to send it. */
  bridge: BridgeInfo | null;
  /** The Claude Code CLI the primary machine runs turns with; null until the
   *  first hello, on a bridge too old to send it, and on a guest connection.
   *  Shown in Settings -> Updates. Never carries the binary's path. */
  claudeCli: ClaudeCliStatus | null;
  /** Whether the primary bridge has a TypeSafe key for smart routing; null
   *  until the first hello and on a bridge too old to say. */
  smartRoutingAvailable: boolean | null;
  /** The Codex CLI on that same machine, on the same terms as `claudeCli`: an
   *  OpenAI model cannot run a turn without it, so the picker and the Updates
   *  pane both read this rather than waiting for a turn to fail. */
  codexCli: CodexCliStatus | null;
  /** Voice input's whisper.cpp on that same machine, for the Updates pane. The
   *  composer reads the *session's* machine slice instead — see Composer. */
  whisper: WhisperStatus | null;
  /** The primary bridge's own model download, for the same pane. */
  whisperModelDownload: WhisperModelDownload | null;
  /** The bridge speaks a contract this client doesn't. Hosted builds ship ahead
   *  of installed bridges, so this is the expected steady state after a deploy,
   *  not an error — the UI degrades rather than throwing. Shows SkewBanner, which
   *  outranks the worker/storage/update pills. Primary machine only, like
   *  `bridge` and `updateStatus`. */
  protocolSkew: boolean;
  /** Authorize URL of the in-progress login, set once the server answers authStartLogin. */
  authorizeUrl: string | null;
  /** Last login failure, shown inline in the login modal. */
  authError: string | null;
  loginModalOpen: boolean;
  /** OpenAI (ChatGPT) account state from the bridge; null until the first `hello`,
   *  and on a bridge too old to send it. */
  openaiAuth: AuthStatus | null;
  /** Device code of the in-progress OpenAI login, set once the server answers
   *  openaiStartLogin. Null means "not started yet", which is what the modal's
   *  first screen keys off. */
  openaiUserCode: string | null;
  openaiVerificationUrl: string | null;
  /** Last OpenAI login failure, shown inline in its modal. */
  openaiAuthError: string | null;
  /** Only ever opened by an explicit Connect click — never auto-opened the way the
   *  Claude modal is. A user with a Claude account is not missing anything. */
  openaiLoginModalOpen: boolean;
  /**
   * Auto-mode guard allowlist. Server-authoritative and never cached in
   * localStorage: it arrives in every `hello`, and a cached copy would be a stale
   * second source of truth for a security-relevant list. Also deliberately absent
   * from `pushSettings()` — the bridge writes entries on its own (permission
   * cards), so a whole-blob settings save would clobber them.
   */
  guardAllowlist: GuardAllowEntry[];
  /** A remote allowlist awaiting accept/reject; null when there is nothing to review. */
  guardReview: GuardAllowlistReview | null;
  guardReviewOpen: boolean;
  /** `detectedAt` of a review the user dismissed with Escape, so a reconnect doesn't re-pop it. */
  guardReviewDismissedAt: number | null;
  /**
   * Agent-memory writes a pull wants to make to the host's disk, awaiting
   * accept/reject. Server-authoritative like the allowlist review beside it, and
   * for a sharper reason: these files are read into every session's prompt on
   * that machine, so nothing may be applied without the user seeing it.
   */
  memoryReview: MemoryReview | null;
  memoryReviewOpen: boolean;
  /** `detectedAt` of a memory review dismissed with Escape. Same rule as the guard's. */
  memoryReviewDismissedAt: number | null;
  /**
   * Why the machine refused this browser's channel, when it did.
   *
   * Load-bearing rather than cosmetic: a machine refuses any relayed browser that
   * cannot present a pinned key — from its first launch, not only once something
   * is enrolled — and the only place to enrol one used to be inside the app shell,
   * which never loads, because the channel was refused. Without this a new
   * browser spins forever with no way forward.
   */
  e2eeRefusal: string | null;
  /**
   * User-managed MCP servers. Server-authoritative and never cached in
   * localStorage, for the same two reasons as the guard allowlist — and one more:
   * the bridge holds header values this client has never seen, so it is also
   * deliberately absent from `pushSettings()`.
   */
  mcpConnections: McpConnection[];
  /** A remote connection list awaiting accept/reject; null when there is nothing to review. */
  mcpReview: McpConnectionsReview | null;
  mcpReviewOpen: boolean;
  /** `detectedAt` of a review dismissed with Escape, so a reconnect doesn't re-pop it. */
  mcpReviewDismissedAt: number | null;
  /** Last MCP status read, per session id. Last-known on purpose: a session with
   *  no live query cannot be asked, and blank would read as "all fine". */
  mcpStatus: Record<string, McpServerStatusInfo[]>;
  /**
   * In-flight or just-finished OAuth handshakes, keyed by server name. Holds the
   * authorization URL to offer, or why the handshake could not start — including
   * "this SDK build no longer exposes the OAuth methods", which is why the text
   * is whatever the server sent rather than a string chosen here.
   */
  mcpAuth: Record<
    string,
    { pending?: boolean; authUrl?: string; alreadyAuthorized?: boolean; error?: string; ok?: boolean }
  >;
  /** What the left sidebar shows: session list or project file tree. */
  sidebarMode: SidebarMode;
  sidebarSearch: SidebarSearchState | null;
  fileSearch: FileSearchState;
  /** Bumped when the search is opened, so its input takes focus even when the
   *  search was already open. */
  searchFocus: number;
  /** Set while a file-search hit is open in the main pane. */
  searchPreview: SearchPreview | null;
  transcriptJump: TranscriptJump | null;
  /** Keep gitignored files out of the file tree and the Cmd+P palette. Persisted
   *  in localStorage, local-only (never synced — it is a per-browser view choice). */
  hideIgnored: boolean;
  /** Transcript compaction level; persisted in localStorage. */
  compactionLevel: CompactionLevel;
  /** Show server-generated 1-2 sentence turn summaries in Compact view; off shows agent narration instead. */
  turnSummariesEnabled: boolean;
  /** Let the bridge resume a turn that died with the app, instead of waiting for the Continue banner. */
  autoContinueInterrupted: boolean;
  /** In plan mode, deny non-read calls instead of raising a card. Global. */
  planModeRejectWrites: boolean;
  /** Append the response-compression ruleset to every session's system prompt. Global. */
  compressResponses: boolean;
  /** Dictation language: `auto` or an ISO 639-1 code. Synced with the settings. */
  voiceLanguage: string;
  /** Turn dictation in any language into English text. */
  voiceTranslate: boolean;
  /** Effort every session's plan-mode turns run at. Global, like codex's own
   *  `plan_mode_reasoning_effort`. Undefined = the session's own effort. */
  planReasoningEffort?: ReasoningEffort;
  /** Per-turn model/effort routing through JEV. Global, synced with the settings. */
  smartRouting?: UserUiSettings['smartRouting'];
  /** Open editor tabs per project path; persisted in localStorage. */
  openFiles: Record<string, OpenFilesState>;

  /** `deviceId` is the link the frame arrived on — '' for a direct bridge. */
  applyServerMessage: (msg: ServerMessage, deviceId?: string) => void;
  setConnectionStatus: (status: ConnectionStatus, deviceId?: string) => void;
  /** Point the UI at a machine; its slice becomes the source of the legacy scalars. */
  setPrimaryMachine: (deviceId: string) => void;
  /** A control message could not be delivered; null clears the notice. */
  setActionError: (message: string | null) => void;
  /**
   * The user asked for a new session. Read by the `sessionUpsert` reducer, which
   * hands selection to the first session id it has never seen — see `pendingCreate`.
   */
  markSessionCreatePending: () => void;
  /** Relay control frames — the machine's bridge attached or went away. */
  setMachineOffline: (offline: boolean, deviceId?: string) => void;
  /**
   * Drop back to "nothing loaded yet". Called when the socket is repointed at a
   * different machine: everything held here describes the old one, and showing it
   * under the new machine's name would be a lie until its `hello` replaces it.
   */
  clearBootstrap: () => void;
  enqueuePrompt: (p: QueuedPrompt) => void;
  /** Return and clear the queue atomically; caller re-sends the drained prompts. */
  drainQueuedPrompts: () => QueuedPrompt[];
  selectSession: (id: string | null) => void;
  /**
   * Land on a session from a notification click: its machine, then its project
   * tab, then the session itself. `selectSession` alone left the UI on another
   * machine or tab, so the click read as "only focused Lines".
   */
  openSessionFromAlert: (id: string) => void;
  /** Fetch the live `/context` breakdown for a session (hover-triggered). */
  requestContextBreakdown: (sessionId: string) => void;
  /** Consume a session's rewind prefill — returns it and clears it, so the text is
   *  handed to the composer exactly once and a remount cannot re-apply it. */
  takeComposerPrefill: (sessionId: string) => RewindPrompt | null;
  /** Clear `focusComposerFor` once the composer has focused itself. */
  takeComposerFocus: () => void;
  /**
   * Register/settle a recipe screenshot upload. The `recipeImageUploaded` reply
   * carries only an uploadId, so the sender records the file name here first;
   * `null` drops a consumed entry.
   */
  trackRecipeUpload: (uploadId: string, entry: { name?: string; url?: string; error?: string } | null) => void;
  setActiveProject: (path: string | null) => void;
  setFolderPickPending: (pending: boolean) => void;
  /** Aim the next folder pick at a project (adds a root) or at nothing (opens a project). */
  setFolderPickTarget: (project: string | null) => void;
  setWorktreePending: (pending: boolean) => void;
  setNewSessionDefaults: (defaults: NewSessionDefaults) => void;
  /** Hide (or restore) an unresolvable checkout in the link hint. */
  setCheckoutDismissed: (cwd: string, dismissed: boolean) => void;
  setAlertsEnabled: (on: boolean) => Promise<void>;
  setAlertSound: (sound: AlertSound) => void;
  testAlertSound: () => void;
  openFilePreview: (raw: string, opts?: { raw?: boolean }) => void;
  closeFilePreview: () => void;
  openLoginModal: () => void;
  closeLoginModal: () => void;
  openOpenaiLoginModal: () => void;
  /** Also cancels the bridge's poll loop — see the implementation. */
  closeOpenaiLoginModal: () => void;
  /** Allowlist an entry (validated client-side first, with the same shared rules). */
  addGuardAllow: (entry: GuardAllowEntry) => void;
  removeGuardAllow: (entry: GuardAllowEntry) => void;
  /** Resolve the pending review: accept installs the remote list, reject keeps this one. */
  resolveGuardReview: (accept: boolean) => void;
  openGuardReview: () => void;
  /** Leaves the review pending (the Settings banner stays) and remembers the dismissal. */
  closeGuardReview: () => void;
  /** Resolve the staged memory pull: accept writes those files on the host. */
  resolveMemoryReview: (accept: boolean) => void;
  /** Leaves the memory review pending and remembers the dismissal. */
  closeMemoryReview: () => void;
  /** Set when a machine refuses this browser for want of an enrolled key; cleared by a `hello`. */
  setE2eeRefusal: (reason: string | null) => void;
  /** Add a connection. `headers` are secret values; they go up and never come back. */
  addMcpConnection: (connection: McpConnectionInput, headers?: Record<string, string>) => void;
  updateMcpConnection: (
    id: string,
    connection: McpConnectionInput,
    headers?: Record<string, string>,
  ) => void;
  removeMcpConnection: (id: string) => void;
  /** Resolve the pending review: accept installs the remote list, reject keeps this one. */
  resolveMcpReview: (accept: boolean) => void;
  openMcpReview: () => void;
  /** Leaves the review pending (the Settings banner stays) and remembers the dismissal. */
  closeMcpReview: () => void;
  /**
   * Ask one session how its MCP servers are doing; the reply lands in `mcpStatus`.
   *
   * `warm` lets the bridge bring the session's query up if it has none, which is
   * the only way to get a reading for a session that has never run a turn. Pass
   * it on an explicit Refresh, not when the pane merely opens — it spawns a CLI
   * child.
   */
  requestMcpStatus: (sessionId: string, warm?: boolean) => void;
  /** Start an OAuth handshake for one server, using a session's live query. */
  authorizeMcpConnection: (sessionId: string, name: string) => void;
  /** Clear a finished/failed authorization notice for one server. */
  clearMcpAuth: (name: string) => void;
  setSidebarMode: (mode: SidebarMode) => void;
  /** Open the sidebar search (on the session list) and focus its input;
   *  `scope` switches it too, as Cmd/Ctrl+Shift+F does for Files. */
  openSidebarSearch: (scope?: SidebarSearchScope) => void;
  /** `null` closes the search, restores the session list and drops the preview. */
  setSidebarSearch: (patch: Partial<SidebarSearchState> | null) => void;
  setFileSearch: (patch: Partial<FileSearchState>) => void;
  setSearchPreview: (preview: SearchPreview | null) => void;
  /** Select `sessionId` and ask its transcript to scroll to the event at `seq`. */
  jumpToTranscript: (sessionId: string, seq: number, toolUseId?: string) => void;
  clearTranscriptJump: () => void;
  setCompactionLevel: (level: CompactionLevel) => void;
  setTurnSummariesEnabled: (on: boolean) => void;
  setAutoContinueInterrupted: (on: boolean) => void;
  setPlanModeRejectWrites: (on: boolean) => void;
  setCompressResponses: (on: boolean) => void;
  setVoiceLanguage: (code: string) => void;
  setVoiceTranslate: (on: boolean) => void;
  /** `null` clears it back to per-session effort. */
  setPlanReasoningEffort: (effort: ReasoningEffort | null) => void;
  setSmartRouting: (routing: UserUiSettings['smartRouting']) => void;
  /** Save this user's TypeSafe key on the primary machine. Write-only. */
  setTypesafeKey: (key: string) => void;
  clearTypesafeKey: () => void;
  setHideIgnored: (on: boolean) => void;
  openFileTab: (path: string) => void;
  closeFileTab: (path: string) => void;
  setActiveFileTab: (path: string) => void;
}

/** How long a "the user asked for a new session" intent stays live. */
const CREATE_INTENT_TTL_MS = 15_000;
let createIntentTimer: ReturnType<typeof setTimeout> | null = null;

export const useStore = create<UiState>((set, get) => {
  /** Mirror the current UI settings to the bridge (and through it, the storage server). */
  const pushSettings = () => {
    const s = get();
    send({
      type: 'saveSettings',
      settings: {
        newSessionDefaults: s.newSessionDefaults,
        sidebarMode: s.sidebarMode,
        compactionLevel: s.compactionLevel,
        turnSummariesEnabled: s.turnSummariesEnabled,
        autoContinueInterrupted: s.autoContinueInterrupted,
        planModeRejectWrites: s.planModeRejectWrites,
        compressResponses: s.compressResponses,
        voiceLanguage: s.voiceLanguage,
        voiceTranslate: s.voiceTranslate,
        planReasoningEffort: s.planReasoningEffort,
        smartRouting: s.smartRouting,
        alertsEnabled: s.alertsEnabled,
        alertSound: s.alertSound,
        dismissedCheckouts: s.dismissedCheckouts,
        updatedAt: Date.now(),
      },
    });
  };

  // --- Transcript event coalescing ------------------------------------------
  // Live events arrive one socket frame at a time, and every `set()` here costs a
  // full buildTranscript pass plus a React reconcile of the whole transcript. So
  // frames buffer and land as ONE `set()` per animation frame. A hidden tab gets
  // no animation frames at all, which is the point: its backlog accumulates in a
  // plain array and commits as a single render on refocus instead of replaying as
  // N sequential renders.
  //
  // Contract: nothing outside `applyServerMessage` may read `transcripts` and
  // expect it settled. Every non-'event' message flushes first (see below).
  const pendingEvents = new Map<string, TranscriptEvent[]>();
  let flushFrame: number | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const isSdkStream = (e: TranscriptEvent) =>
    e.kind === 'sdk' && (e.data as { type?: string } | null)?.type === 'stream_event';

  const flushPendingEvents = () => {
    if (flushFrame != null) {
      cancelAnimationFrame(flushFrame);
      flushFrame = null;
    }
    if (flushTimer != null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingEvents.size === 0) return;
    const batches = [...pendingEvents];
    pendingEvents.clear();
    set((state) => {
      const transcripts = { ...state.transcripts };
      const lastEventAt = { ...state.lastEventAt };
      const now = Date.now();
      let changed = false;
      for (const [sessionId, batch] of batches) {
        const existing = transcripts[sessionId] ?? [];
        // One Set per flush instead of a linear scan per event: duplicates happen
        // (history replay racing live events) and the scan was O(n·k).
        const seen = new Set(existing.map((e) => e.seq));
        const fresh: TranscriptEvent[] = [];
        // A complete (non-stream) SDK message supersedes the deltas that built up
        // to it. Applied once over the batch, at its *last* complete message —
        // which subsumes every earlier one, exactly as the per-event rule did.
        let lastComplete = -1;
        for (const event of batch) {
          if (seen.has(event.seq)) continue;
          seen.add(event.seq);
          if (event.kind === 'sdk' && !isSdkStream(event)) lastComplete = fresh.length;
          fresh.push(event);
        }
        if (fresh.length === 0) continue;
        const base = lastComplete >= 0 ? existing.filter((e) => !isSdkStream(e)) : existing;
        const tail =
          lastComplete >= 0 ? fresh.filter((e, i) => i >= lastComplete || !isSdkStream(e)) : fresh;
        transcripts[sessionId] = [...base, ...tail];
        lastEventAt[sessionId] = now;
        changed = true;
      }
      if (!changed) return state;
      return { transcripts, lastEventAt };
    });
  };

  const scheduleFlush = () => {
    if (flushFrame != null || flushTimer != null) return;
    if (typeof requestAnimationFrame === 'function') {
      flushFrame = requestAnimationFrame(() => {
        flushFrame = null;
        flushPendingEvents();
      });
    } else {
      // Fallback for an environment with no rAF at all — the buffer must still drain.
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushPendingEvents();
      }, 16);
    }
  };

  if (typeof document !== 'undefined') {
    // rAF stays parked while hidden; refocus is where the backlog commits.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) flushPendingEvents();
    });
  }

  /** Apply settings from the server (hello or another tab/instance) without re-sending. */
  const applySettings = (s: UserUiSettings) => {
    set((state) => ({
      newSessionDefaults: s.newSessionDefaults ?? state.newSessionDefaults,
      sidebarMode: s.sidebarMode ?? state.sidebarMode,
      compactionLevel: s.compactionLevel ?? state.compactionLevel,
      turnSummariesEnabled: s.turnSummariesEnabled ?? state.turnSummariesEnabled,
      autoContinueInterrupted: s.autoContinueInterrupted ?? state.autoContinueInterrupted,
      planModeRejectWrites: s.planModeRejectWrites ?? state.planModeRejectWrites,
      compressResponses: s.compressResponses ?? state.compressResponses,
      voiceLanguage: s.voiceLanguage ?? state.voiceLanguage,
      voiceTranslate: s.voiceTranslate ?? state.voiceTranslate,
      planReasoningEffort: s.planReasoningEffort ?? state.planReasoningEffort,
      smartRouting: s.smartRouting ?? state.smartRouting,
      alertsEnabled: s.alertsEnabled ?? state.alertsEnabled,
      alertSound: (s.alertSound as AlertSound | undefined) ?? state.alertSound,
      dismissedCheckouts: s.dismissedCheckouts ?? state.dismissedCheckouts,
    }));
    // Keep the offline caches current so a cold start matches the server.
    if (s.newSessionDefaults) localStorage.setItem(NEW_SESSION_DEFAULTS_KEY, JSON.stringify(s.newSessionDefaults));
    if (s.sidebarMode) localStorage.setItem(SIDEBAR_MODE_KEY, s.sidebarMode);
    if (s.compactionLevel) localStorage.setItem(COMPACTION_LEVEL_KEY, s.compactionLevel);
    if (s.turnSummariesEnabled != null) localStorage.setItem(TURN_SUMMARIES_ENABLED_KEY, String(s.turnSummariesEnabled));
    if (s.autoContinueInterrupted != null) localStorage.setItem(AUTO_CONTINUE_KEY, String(s.autoContinueInterrupted));
    if (s.planModeRejectWrites != null) localStorage.setItem(PLAN_REJECT_WRITES_KEY, String(s.planModeRejectWrites));
    if (s.compressResponses != null) localStorage.setItem(COMPRESS_RESPONSES_KEY, String(s.compressResponses));
    if (s.voiceLanguage) localStorage.setItem(VOICE_LANGUAGE_KEY, s.voiceLanguage);
    if (s.voiceTranslate != null) localStorage.setItem(VOICE_TRANSLATE_KEY, String(s.voiceTranslate));
    if (s.planReasoningEffort) localStorage.setItem(PLAN_REASONING_EFFORT_KEY, s.planReasoningEffort);
    if (s.smartRouting) localStorage.setItem(SMART_ROUTING_KEY, JSON.stringify(s.smartRouting));
    if (s.alertsEnabled != null) persistAlertsEnabled(s.alertsEnabled);
    if (s.alertSound) persistAlertSound(s.alertSound as AlertSound);
    if (s.dismissedCheckouts) {
      localStorage.setItem(DISMISSED_CHECKOUTS_KEY, JSON.stringify(s.dismissedCheckouts));
    }
  };

  return {
  connectionStatus: 'reconnecting',
  bootstrapped: false,
  machineOffline: false,
  access: null,
  presence: {},
  profiles: {},
  machines: {},
  primaryDeviceId: null,
  sessionMachine: {},
  actionError: null,
  helloSignature: null,
  seenSessionIds: new Set<string>(),
  pendingCreate: false,
  queuedPrompts: [],
  sessions: {},
  workflows: [],
  sharedWorkflows: [],
  steps: [],
  sharedSteps: [],
  pinnedSteps: [],
  stepVersions: {},
  recipes: [],
  sharedRecipes: [],
  recipeVersions: {},
  recipeStats: {},
  recipeUploads: {},
  models: [],
  recentDirs: [],
  projects: [],
  projectKeys: {},
  dismissedCheckouts: loadDismissedCheckouts(),
  activeProject: localStorage.getItem(ACTIVE_PROJECT_KEY),
  seenSessionStatus: {},
  transcripts: {},
  transcriptLoaded: {},
  lastEventAt: {},
  composerPrefill: {},
  focusComposerFor: null,
  contextBreakdowns: {},
  selectedSessionId: sessionIdFromUrl(),
  folderPickPending: false,
  folderPickTarget: null,
  worktreePending: false,
  newSessionDefaults: loadNewSessionDefaults(),
  alertsEnabled: loadAlertsEnabled(),
  alertSound: loadAlertSound(),
  notifyPermission: 'Notification' in window ? Notification.permission : 'denied',
  filePreview: null,
  usage: null,
  openaiUsage: null,
  spendHistory: null,
  auth: null,
  storageStatus: null,
  workerStatus: null,
  updateStatus: null,
  bridge: null,
  claudeCli: null,
  smartRoutingAvailable: null,
  codexCli: null,
  whisper: null,
  whisperModelDownload: null,
  protocolSkew: false,
  authorizeUrl: null,
  authError: null,
  loginModalOpen: false,
  openaiAuth: null,
  openaiUserCode: null,
  openaiVerificationUrl: null,
  openaiAuthError: null,
  openaiLoginModalOpen: false,
  guardAllowlist: [],
  guardReview: null,
  guardReviewOpen: false,
  guardReviewDismissedAt: null,
  memoryReview: null,
  memoryReviewOpen: false,
  memoryReviewDismissedAt: null,
  e2eeRefusal: null,
  mcpConnections: [],
  mcpReview: null,
  mcpReviewOpen: false,
  mcpReviewDismissedAt: null,
  mcpStatus: {},
  mcpAuth: {},
  sidebarMode: loadSidebarMode(),
  sidebarSearch: null,
  fileSearch: {
    caseSensitive: false,
    regex: false,
    wholeWord: false,
    results: null,
    resultsFor: '',
    loading: false,
    error: null,
  },
  searchFocus: 0,
  searchPreview: null,
  transcriptJump: null,
  hideIgnored: loadHideIgnored(),
  compactionLevel: loadCompactionLevel(),
  turnSummariesEnabled: loadTurnSummariesEnabled(),
  autoContinueInterrupted: loadAutoContinueInterrupted(),
  planModeRejectWrites: loadPlanModeRejectWrites(),
  compressResponses: loadCompressResponses(),
  voiceLanguage: loadVoiceLanguage(),
  voiceTranslate: localStorage.getItem(VOICE_TRANSLATE_KEY) === 'true',
  planReasoningEffort: loadPlanReasoningEffort(),
  smartRouting: loadSmartRouting(),
  openFiles: loadOpenFiles(),

  setConnectionStatus: (status, deviceId) =>
    set((state) => {
      const id = deviceId ?? state.primaryDeviceId ?? '';
      const slice = { ...(state.machines[id] ?? emptyMachine(id)), connectionStatus: status };
      return {
        machines: { ...state.machines, [id]: slice },
        // Derived, not replaced: the banners keep their existing precedence, which
        // is scoped to the machine the user is looking at.
        ...(isPrimary(state, id) ? { connectionStatus: status } : {}),
      };
    }),
  setPrimaryMachine: (deviceId) =>
    set((state) => {
      // Already the machine in front of the user: nothing to re-derive, and
      // re-deriving anyway would be destructive. The device list refreshes on
      // its own schedule and re-runs the gate's effect with the same machine,
      // and this now projects a whole `view` — so a no-op here is what keeps a
      // refresh from reverting the globals to that machine's last `hello`.
      if (state.primaryDeviceId === deviceId) return {};
      const slice = state.machines[deviceId] ?? emptyMachine(deviceId);
      // Re-derive every scalar from the machine now in front of the user, so the
      // banners describe it rather than whichever machine spoke last.
      return {
        primaryDeviceId: deviceId,
        machines: { ...state.machines, [deviceId]: slice },
        // The same projection the `hello` reducer makes for the primary machine,
        // so a switch swaps projects, library, usage and account state in one go
        // and without waiting for a round trip. Held per machine precisely so
        // this is possible; see MachineView.
        ...slice.view,
        // Only once that machine has said `hello`. Before it, an empty project
        // list is "not asked yet", and choosing against it would throw away the
        // project this browser remembers across a reload — which is exactly the
        // state the very first switch of a session runs in.
        activeProject: slice.bootstrapped
          ? pickActive(slice.view.projects, state.activeProject)
          : state.activeProject,
        // A session the new machine does not host must not stay selected — the
        // view would be pointed at another computer's session while every control
        // around it describes this one, and App.tsx re-activates a selected
        // session's project, which would drag the tab back across with it.
        selectedSessionId:
          state.selectedSessionId &&
          (state.sessionMachine[state.selectedSessionId] ?? deviceId) === deviceId
            ? state.selectedSessionId
            : null,
        connectionStatus: slice.connectionStatus,
        machineOffline: slice.machineOffline,
        bootstrapped: slice.bootstrapped,
        workerStatus: slice.worker,
        storageStatus: slice.storage,
        updateStatus: slice.update,
        bridge: slice.bridge,
        claudeCli: slice.claudeCli,
        codexCli: slice.codexCli,
        whisper: slice.whisper,
        // Only meaningful once that machine has said `hello`: before it, a null
        // `bridge` is "not asked yet", not a pre-versioning bridge, and reading it
        // as skew would flash the pill on every machine switch.
        protocolSkew: slice.bootstrapped && slice.bridge?.appProtocol !== APP_PROTOCOL_VERSION,
      };
    }),
  setMachineOffline: (offline, deviceId) =>
    set((state) => {
      const id = deviceId ?? state.primaryDeviceId ?? '';
      const slice = { ...(state.machines[id] ?? emptyMachine(id)), machineOffline: offline };
      return {
        machines: { ...state.machines, [id]: slice },
        ...(isPrimary(state, id) ? { machineOffline: offline } : {}),
      };
    }),
  setActionError: (message) => set({ actionError: message }),
  markSessionCreatePending: () => {
    if (createIntentTimer) clearTimeout(createIntentTimer);
    // Expires on its own: a create that never lands (the socket dropped, the bridge
    // refused) must not leave an intent behind for an unrelated session to consume.
    createIntentTimer = setTimeout(() => {
      createIntentTimer = null;
      set({ pendingCreate: false });
    }, CREATE_INTENT_TTL_MS);
    set({ pendingCreate: true });
  },
  // Also clears machineOffline: it describes the machine we are leaving, and a
  // stale "offline" would put the escalated copy up before the new one is tried.
  // The hello fingerprint and the seen-id set go with it — they describe the old
  // machine's sessions, and keeping them would make the new machine's first `hello`
  // look like a duplicate.
  clearBootstrap: () =>
    set({
      bootstrapped: false,
      machineOffline: false,
      // Goes with the rest: it describes the machine we are leaving, and carrying
      // a guest's narrowed access onto a machine we own would hide our own UI.
      access: null,
      // Whoever was watching was watching the *previous* machine's sessions.
      presence: {},
      // Names are keyed by user id, which is machine-independent, so they stay
      // valid across a switch and are worth keeping.
      helloSignature: null,
      seenSessionIds: new Set<string>(),
      pendingCreate: false,
      focusComposerFor: null,
      // Goes with `pendingCreate` for the same reason: it describes a create in
      // flight on the machine we are leaving, and leaving it set would keep the
      // new machine's New session button disabled.
      worktreePending: false,
    }),
  enqueuePrompt: (p) => set((state) => ({ queuedPrompts: [...state.queuedPrompts, p] })),
  drainQueuedPrompts: () => {
    const queued = get().queuedPrompts;
    if (queued.length) set({ queuedPrompts: [] });
    return queued;
  },
  selectSession: (id) => set({ selectedSessionId: id }),
  openSessionFromAlert: (id) => {
    const state = get();
    const target = alertTarget({
      sessionId: id,
      sessions: state.sessions,
      sessionMachine: state.sessionMachine,
      machines: state.machines,
      primaryDeviceId: state.primaryDeviceId,
      projects: state.projects,
      projectKeys: state.projectKeys,
    });
    if (target?.switchMachine) {
      // What the machine switcher's pick does: remembered too, or the device
      // gate re-chooses the old machine on its next refresh.
      rememberDeviceId(target.deviceId);
      switchDevice(target.deviceId);
    }
    // Before selecting: the session belongs to this tab, so `setActiveProject`
    // keeps whatever is selected there only if it is already this session —
    // selecting afterwards is what guarantees it.
    if (target?.projectPath && target.projectPath !== get().activeProject) {
      get().setActiveProject(target.projectPath);
    }
    get().selectSession(id);
  },
  setFolderPickPending: (pending) => set({ folderPickPending: pending }),
  setFolderPickTarget: (project) => set({ folderPickTarget: project }),
  setWorktreePending: (pending) => set({ worktreePending: pending }),

  openFilePreview: (raw, opts) => {
    // Split off a trailing :line(:col); the path itself never ends in a digit-only segment.
    const m = raw.match(/^(.*?)(?::(\d+)(?::(\d+))?)?$/);
    const rawPath = m?.[1] ?? raw;
    const line = m?.[2] ? Number(m[2]) : undefined;
    const col = m?.[3] ? Number(m[3]) : undefined;
    const state = get();
    const cwd = state.selectedSessionId
      ? state.sessions[state.selectedSessionId]?.cwd
      : undefined;
    // Absolute or ~-rooted paths pass through (server expands ~); relative resolves against cwd.
    let resolved = rawPath;
    if (!rawPath.startsWith('/') && !rawPath.startsWith('~')) {
      if (!cwd) return; // no base to resolve against
      resolved = `${cwd}/${rawPath.replace(/^\.\//, '')}`;
    }
    set({ filePreview: { path: resolved, display: rawPath, line, col, raw: opts?.raw } });
  },
  closeFilePreview: () => set({ filePreview: null }),

  openLoginModal: () => set({ loginModalOpen: true, authError: null }),
  closeLoginModal: () => set({ loginModalOpen: false, authorizeUrl: null, authError: null }),

  openOpenaiLoginModal: () => set({ openaiLoginModalOpen: true, openaiAuthError: null }),
  closeOpenaiLoginModal: () => {
    // Tell the bridge to stop polling OpenAI: a device-code flow nobody is
    // watching would otherwise poll until the code expired.
    if (get().openaiUserCode) send({ type: 'openaiCancelLogin' });
    set({
      openaiLoginModalOpen: false,
      openaiUserCode: null,
      openaiVerificationUrl: null,
      openaiAuthError: null,
    });
  },

  // Intent messages, not a list save: the bridge is the only writer of the list
  // and echoes the whole thing back on `guardAllowlist`.
  addGuardAllow: (entry) => send({ type: 'addGuardAllow', entry }),
  removeGuardAllow: (entry) => send({ type: 'removeGuardAllow', entry }),
  resolveGuardReview: (accept) => {
    // Closed optimistically; the server's `guardAllowlistReview: null` confirms it
    // (and closes any other tab showing the same modal).
    set({ guardReviewOpen: false });
    send({ type: 'reviewGuardAllowlist', accept });
  },
  openGuardReview: () => set({ guardReviewOpen: true }),
  closeGuardReview: () =>
    set((state) => ({
      guardReviewOpen: false,
      guardReviewDismissedAt: state.guardReview?.detectedAt ?? state.guardReviewDismissedAt,
    })),
  resolveMemoryReview: (accept) => {
    // Closed optimistically, exactly like the allowlist review; the server's
    // `memoryReview: null` confirms it and closes the modal in other tabs.
    set({ memoryReviewOpen: false });
    send({ type: 'reviewMemory', accept });
  },
  closeMemoryReview: () =>
    set((state) => ({
      memoryReviewOpen: false,
      memoryReviewDismissedAt: state.memoryReview?.detectedAt ?? state.memoryReviewDismissedAt,
    })),
  setE2eeRefusal: (reason) => set({ e2eeRefusal: reason }),

  // Intent messages, not a list save, for the same reason the guard's are — and
  // one more: the bridge holds header values this client cannot round-trip.
  addMcpConnection: (connection, headers) => send({ type: 'addMcpConnection', connection, headers }),
  updateMcpConnection: (id, connection, headers) =>
    send({ type: 'updateMcpConnection', id, connection, headers }),
  removeMcpConnection: (id) => send({ type: 'removeMcpConnection', id }),
  resolveMcpReview: (accept) => {
    // Closed optimistically; the server's `mcpConnectionsReview: null` confirms it
    // (and closes any other tab showing the same modal).
    set({ mcpReviewOpen: false });
    send({ type: 'reviewMcpConnections', accept });
  },
  openMcpReview: () => set({ mcpReviewOpen: true }),
  closeMcpReview: () =>
    set((state) => ({
      mcpReviewOpen: false,
      mcpReviewDismissedAt: state.mcpReview?.detectedAt ?? state.mcpReviewDismissedAt,
    })),
  requestMcpStatus: (sessionId, warm) =>
    send({ type: 'mcpServerStatus', sessionId, ...(warm ? { warm: true } : {}) }),
  authorizeMcpConnection: (sessionId, name) => {
    set((state) => ({ mcpAuth: { ...state.mcpAuth, [name]: { pending: true } } }));
    send({ type: 'authorizeMcpConnection', sessionId, name });
  },
  clearMcpAuth: (name) =>
    set((state) => {
      const next = { ...state.mcpAuth };
      delete next[name];
      return { mcpAuth: next };
    }),

  setSidebarMode: (mode) => {
    localStorage.setItem(SIDEBAR_MODE_KEY, mode);
    set({ sidebarMode: mode });
    pushSettings();
  },
  openSidebarSearch: (scope) => {
    // The search lives over the session list; the file tree has no room for it.
    if (get().sidebarMode !== 'sessions') get().setSidebarMode('sessions');
    get().setSidebarSearch(scope ? { scope } : {});
    set((state) => ({ searchFocus: state.searchFocus + 1 }));
  },
  setSidebarSearch: (patch) =>
    set((state) => {
      if (patch === null) return { sidebarSearch: null, searchPreview: null };
      const base: SidebarSearchState = state.sidebarSearch ?? {
        query: '',
        scope: 'all',
        results: null,
        resultsFor: '',
        loading: false,
        error: null,
      };
      const next = { ...base, ...patch };
      // The preview belongs to the Files scope's results; leaving it hands the
      // main pane back to the session.
      return next.scope === 'files'
        ? { sidebarSearch: next }
        : { sidebarSearch: next, searchPreview: null };
    }),
  setFileSearch: (patch) => set((state) => ({ fileSearch: { ...state.fileSearch, ...patch } })),
  setSearchPreview: (preview) => set({ searchPreview: preview }),
  jumpToTranscript: (sessionId, seq, toolUseId) => {
    const query = get().sidebarSearch?.query ?? '';
    if (get().selectedSessionId !== sessionId) get().selectSession(sessionId);
    set((state) => ({
      transcriptJump: {
        sessionId,
        seq,
        toolUseId,
        query,
        nonce: (state.transcriptJump?.nonce ?? 0) + 1,
      },
    }));
  },
  clearTranscriptJump: () => set({ transcriptJump: null }),

  setHideIgnored: (on) => {
    localStorage.setItem(HIDE_IGNORED_KEY, String(on));
    set({ hideIgnored: on });
  },

  setCompactionLevel: (level) => {
    localStorage.setItem(COMPACTION_LEVEL_KEY, level);
    set({ compactionLevel: level });
    pushSettings();
  },

  setTurnSummariesEnabled: (on) => {
    localStorage.setItem(TURN_SUMMARIES_ENABLED_KEY, String(on));
    set({ turnSummariesEnabled: on });
    pushSettings();
  },

  setAutoContinueInterrupted: (on) => {
    localStorage.setItem(AUTO_CONTINUE_KEY, String(on));
    set({ autoContinueInterrupted: on });
    pushSettings();
  },

  setPlanModeRejectWrites: (on) => {
    localStorage.setItem(PLAN_REJECT_WRITES_KEY, String(on));
    set({ planModeRejectWrites: on });
    pushSettings();
  },

  setVoiceLanguage: (code) => {
    localStorage.setItem(VOICE_LANGUAGE_KEY, code);
    set({ voiceLanguage: code });
    pushSettings();
  },

  setVoiceTranslate: (on) => {
    localStorage.setItem(VOICE_TRANSLATE_KEY, String(on));
    set({ voiceTranslate: on });
    pushSettings();
  },

  setCompressResponses: (on) => {
    localStorage.setItem(COMPRESS_RESPONSES_KEY, String(on));
    set({ compressResponses: on });
    pushSettings();
  },

  setPlanReasoningEffort: (effort) => {
    if (effort) localStorage.setItem(PLAN_REASONING_EFFORT_KEY, effort);
    else localStorage.removeItem(PLAN_REASONING_EFFORT_KEY);
    set({ planReasoningEffort: effort ?? undefined });
    pushSettings();
  },

  setSmartRouting: (routing) => {
    if (routing) localStorage.setItem(SMART_ROUTING_KEY, JSON.stringify(routing));
    else localStorage.removeItem(SMART_ROUTING_KEY);
    set({ smartRouting: routing });
    pushSettings();
  },

  // No optimistic flip: the bridge may refuse the key, and its
  // `smartRoutingAvailable` broadcast updates every tab, this one included.
  setTypesafeKey: (key) => {
    send({ type: 'setTypesafeKey', key });
  },

  clearTypesafeKey: () => {
    send({ type: 'clearTypesafeKey' });
  },

  openFileTab: (path) => {
    const project = get().activeProject;
    if (!project) return;
    set((state) => {
      const current = state.openFiles[project] ?? { tabs: [], active: null };
      const tabs = current.tabs.includes(path) ? current.tabs : [...current.tabs, path];
      const openFiles = { ...state.openFiles, [project]: { tabs, active: path } };
      persistOpenFiles(openFiles);
      return { openFiles };
    });
  },

  closeFileTab: (path) => {
    const project = get().activeProject;
    if (!project) return;
    set((state) => {
      const current = state.openFiles[project];
      if (!current) return state;
      const tabs = current.tabs.filter((t) => t !== path);
      // Closing the active tab falls back to its neighbor (previous index, clamped).
      let active = current.active;
      if (active === path) {
        const idx = current.tabs.indexOf(path);
        active = tabs[Math.min(idx, tabs.length - 1)] ?? null;
      }
      const openFiles = { ...state.openFiles, [project]: { tabs, active } };
      persistOpenFiles(openFiles);
      return { openFiles };
    });
  },

  setActiveFileTab: (path) => {
    const project = get().activeProject;
    if (!project) return;
    set((state) => {
      const current = state.openFiles[project] ?? { tabs: [], active: null };
      const openFiles = { ...state.openFiles, [project]: { ...current, active: path } };
      persistOpenFiles(openFiles);
      return { openFiles };
    });
  },

  setAlertsEnabled: async (on) => {
    persistAlertsEnabled(on);
    if (on) {
      primeAudio();
      const permission = await requestNotifyPermission();
      set({ alertsEnabled: true, notifyPermission: permission });
      if (permission === 'granted') void registerPushWith(pushMachines(get()));
    } else {
      set({ alertsEnabled: false });
      void unregisterPushFrom(pushMachines(get()));
    }
    pushSettings();
  },

  setAlertSound: (sound) => {
    persistAlertSound(sound);
    set({ alertSound: sound });
    pushSettings();
  },

  testAlertSound: () => {
    primeAudio();
    playSound(get().alertSound);
  },

  setNewSessionDefaults: (defaults) => {
    localStorage.setItem(NEW_SESSION_DEFAULTS_KEY, JSON.stringify(defaults));
    set({ newSessionDefaults: defaults });
    pushSettings();
  },

  setCheckoutDismissed: (cwd, dismissed) => {
    const next = get().dismissedCheckouts.filter((p) => p !== cwd);
    if (dismissed) next.push(cwd);
    localStorage.setItem(DISMISSED_CHECKOUTS_KEY, JSON.stringify(next));
    set({ dismissedCheckouts: next });
    pushSettings();
  },

  trackRecipeUpload: (uploadId, entry) => {
    set((state) => {
      const recipeUploads = { ...state.recipeUploads };
      const prev = recipeUploads[uploadId];
      if (entry) recipeUploads[uploadId] = { ...prev, ...entry, name: entry.name ?? prev?.name ?? '' };
      else delete recipeUploads[uploadId];
      return { recipeUploads };
    });
  },

  requestContextBreakdown: (sessionId) => {
    const prev = get().contextBreakdowns[sessionId];
    if (prev?.loading) return; // one request in flight per session
    set((state) => ({
      contextBreakdowns: {
        ...state.contextBreakdowns,
        [sessionId]: { breakdown: prev?.breakdown ?? null, at: prev?.at ?? 0, loading: true },
      },
    }));
    send({ type: 'contextBreakdown', sessionId });
  },

  takeComposerPrefill: (sessionId) => {
    const prefill = get().composerPrefill[sessionId];
    if (!prefill) return null;
    set((state) => {
      const composerPrefill = { ...state.composerPrefill };
      delete composerPrefill[sessionId];
      return { composerPrefill };
    });
    return prefill;
  },
  takeComposerFocus: () => set({ focusComposerFor: null }),

  setActiveProject: (path) => {
    if (path) localStorage.setItem(ACTIVE_PROJECT_KEY, path);
    else localStorage.removeItem(ACTIVE_PROJECT_KEY);
    set((state) => {
      let selected = state.selectedSessionId;
      const current = selected ? state.sessions[selected] : undefined;
      // A tab activated before the server's `projects` echo lands (open-recent, a
      // fresh folder pick) isn't in the list yet — treat it as a bare single root
      // so its existing sessions still get picked up.
      const project = path ? projectAt(state.projects, path) ?? { path } : null;
      if (!project) {
        selected = null;
      } else {
        // Keep a selection that already belongs here — including an archived
        // one, so deep-linking to it survives a tab switch. Membership is
        // key-aware, matching what the sidebar lists.
        const inProject =
          current != null &&
          sessionsInProject(state.sessions, state.projectKeys, project).some((s) => s.id === current.id);
        // Otherwise switching tabs lands where the user last was in that project,
        // or on its latest active session when that one is gone or archived.
        if (!inProject) {
          selected =
            rememberedSessionIn(state.sessions, state.projectKeys, project)?.id ??
            latestSessionIn(state.sessions, state.projectKeys, project)?.id ??
            null;
        }
      }
      return { activeProject: path, selectedSessionId: selected };
    });
  },

  applyServerMessage: (msg, deviceId) => {
    /** The link this frame arrived on. '' is a direct bridge. */
    const from = deviceId ?? get().primaryDeviceId ?? '';
    /** Is this the machine whose state the banners and account UI describe? */
    const fromPrimary = from === (get().primaryDeviceId ?? '');
    // Any handler that reads or replaces `transcripts` — 'transcript', 'hello',
    // 'sessionDeleted' — must see a settled array, so drain the coalescing buffer
    // before anything but another 'event'.
    if (msg.type !== 'event') flushPendingEvents();
    switch (msg.type) {
      case 'hello': {
        const incoming: Record<string, SessionMeta> = {};
        for (const s of msg.sessions) incoming[s.id] = s;
        // Everything this machine says about its own projects, library and
        // account, folded against what it said last time — never against the
        // globals, which describe whichever machine is in front of the user.
        const view = machineView(msg, get().machines[from]?.view ?? emptyView());
        const signature = helloSignature(msg.sessions, view.projects);
        // A duplicate `hello` has to be inert. The bridge sends a full snapshot per
        // channel `open`, and the relay replays `open` for every live channel each
        // time a bridge attaches — so a takeover delivers one to a browser that never
        // reconnected. Re-applying it replaced `sessions` and blanked the transcript
        // and breakdown caches, which reloaded transcripts and fed the next round.
        const repeat = signature === get().helloSignature && fromPrimary;
        set((state) => {
          // Fold this machine's sessions in rather than replacing the map: with two
          // links open, a wholesale replace means whichever machine said hello last
          // wins and the other's sessions disappear from the sidebar.
          const merged = mergeMachineSessions({
            sessions: state.sessions,
            sessionMachine: state.sessionMachine,
            deviceId: from,
            incoming: Object.values(incoming),
          });
          const slice: MachineSlice = {
            ...(state.machines[from] ?? emptyMachine(from)),
            bootstrapped: true,
            machineOffline: false,
            connectionStatus: 'connected',
            worker: msg.worker ?? null,
            storage: msg.storage ?? null,
            update: msg.update ?? null,
            bridge: msg.bridge ?? null,
            claudeCli: msg.claudeCli ?? null,
            codexCli: msg.codexCli ?? null,
            whisper: msg.whisper ?? null,
            scope: msg.access?.scope ?? 'owner',
            ownerProfile: msg.access?.ownerProfile ?? null,
            // Absent on a bridge older than the field, which reads as "not
            // local" — the fail-closed direction for a control that opens a
            // dialog on the host's screen.
            local: msg.local ?? false,
            // Same fail-closed reading as `local`: absent means "no evidence of
            // encryption", which is what an older bridge honestly offers.
            encrypted: msg.encrypted ?? false,
            // Owner links only: a guest may not subscribe, and the bridge says so.
            push: !msg.access && msg.pushAvailable === true,
            view,
          };
          return {
          machines: { ...state.machines, [from]: slice },
          sessionMachine: merged.sessionMachine,
          bootstrapped: fromPrimary ? true : state.bootstrapped,
          // A `hello` is proof the bridge is there, whatever the relay last said.
          machineOffline: fromPrimary ? false : state.machineOffline,
          helloSignature: fromPrimary ? signature : state.helloSignature,
          seenSessionIds: withSeen(state.seenSessionIds, Object.keys(incoming)),
          ...(repeat ? {} : { sessions: merged.sessions }),
          // The owner state this machine described, onto the globals — but only
          // when it *is* the machine in front of the user. Every field of a
          // `MachineView` is named after its global counterpart, so the spread is
          // the whole projection and `setPrimaryMachine` can make the identical
          // one on a switch. A shared machine's thin hello (empty projects, no
          // account, a narrowed `access`) used to land here and blank the
          // primary's UI until its next hello put it back.
          ...(fromPrimary ? { ...view, activeProject: pickActive(view.projects, state.activeProject) } : {}),
          // Gated on `fromPrimary`, like `update`/`bridge`/`claudeCli` below and
          // for the same reason: the ledger is machine-local and a guest `hello`
          // never carries one, so an ungated read would let a second machine wipe
          // the primary's history the moment it says hello.
          spendHistory: fromPrimary ? msg.spendHistory ?? state.spendHistory : state.spendHistory,
          // Banner scalars, so they follow their `bridge`/`update` neighbours
          // rather than the machine that happened to speak last;
          // `setPrimaryMachine` re-derives both from the new machine's slice.
          storageStatus: fromPrimary ? msg.storage ?? null : state.storageStatus,
          // Absent on a bridge older than this field — degrades to "no strip".
          workerStatus: fromPrimary ? msg.worker ?? null : state.workerStatus,
          // Gated on `fromPrimary`, unlike its neighbours: a guest `hello` never
          // carries `update`, so an ungated read would let a second machine's
          // hello wipe a pending update off the primary.
          updateStatus: fromPrimary ? msg.update ?? null : state.updateStatus,
          // Gated on `fromPrimary`, like `update` above and for the same reason:
          // these two describe the bridge the banners speak about, so a second
          // machine's hello must not retag them (and SkewBanner reads both, which
          // only reads straight if they move together).
          bridge: fromPrimary ? msg.bridge ?? null : state.bridge,
          // Gated on `fromPrimary` like `update` and `bridge` above: a guest
          // `hello` never carries it, so an ungated read would blank the pane
          // the moment a second machine says hello.
          claudeCli: fromPrimary ? msg.claudeCli ?? null : state.claudeCli,
          smartRoutingAvailable: fromPrimary ? msg.smartRoutingAvailable ?? null : state.smartRoutingAvailable,
          codexCli: fromPrimary ? msg.codexCli ?? null : state.codexCli,
          whisper: fromPrimary ? msg.whisper ?? null : state.whisper,
          whisperModelDownload: fromPrimary ? msg.whisperModelDownload ?? null : state.whisperModelDownload,
          // `access` rides the view spread above, gated with the rest of the
          // owner state: it says whose machine the UI is describing, and a shared
          // machine's hello setting it globally is what flipped the sidebar into
          // its guest layout while the user was looking at their own machine.
          //
          // `profiles` stays ungated on purpose — it is keyed by user id, so it
          // names people rather than describing a machine, and a guest row needs
          // the host's name whichever machine is primary.
          profiles: msg.access?.ownerProfile
            ? { ...state.profiles, [msg.access.ownerProfile.userId]: msg.access.ownerProfile }
            : state.profiles,
          // Absent `bridge` means a bridge older than this field — treat as skew.
          protocolSkew: fromPrimary
            ? msg.bridge?.appProtocol !== APP_PROTOCOL_VERSION
            : state.protocolSkew,
          // Logged out? Open the login flow — but only on the first hello with
          // that news, so reconnects don't reopen a dismissed modal.
          // Never on somebody else's machine. A guest's hello reports
          // `loggedIn: false` because the host's Claude account is none of their
          // business — but that is "not your concern", not "you must sign in",
          // and turns there run on the host's token either way. Prompting a guest
          // to connect an account would be asking them to fix something they
          // cannot see and do not own.
          // Gated on "no provider connected", not on Claude alone: an OpenAI-only
          // user is signed in to something and must not be nagged to sign in to
          // Claude on every launch.
          //
          // The four auto-open flags below stay global — a modal is a property of
          // the window, not of a machine — but every one of them is gated on
          // `fromPrimary` as well: a background machine must never raise a dialog
          // about an account the user is not currently looking at.
          loginModalOpen: !fromPrimary
            ? state.loginModalOpen
            : msg.access
              ? false
              : state.loginModalOpen ||
                (!msg.auth.loggedIn &&
                  !msg.openaiAuth?.loggedIn &&
                  state.auth?.loggedIn !== false),
          // Same "auto-open on genuinely new news" rule as the login modal: a
          // review the user already dismissed must not reopen on every reconnect,
          // but a divergence they have not seen has to reach them unprompted.
          guardReviewOpen:
            state.guardReviewOpen ||
            (fromPrimary &&
              msg.guardAllowlistReview != null &&
              msg.guardAllowlistReview.detectedAt !== state.guardReviewDismissedAt),
          // Same auto-open-on-genuinely-new-news rule as the allowlist review.
          memoryReviewOpen:
            state.memoryReviewOpen ||
            (fromPrimary &&
              msg.memoryReview != null &&
              msg.memoryReview.detectedAt !== state.memoryReviewDismissedAt),
          // Same auto-open-on-new-news rule as the allowlist review above.
          mcpReviewOpen:
            state.mcpReviewOpen ||
            (fromPrimary &&
              msg.mcpConnectionsReview != null &&
              msg.mcpConnectionsReview.detectedAt !== state.mcpReviewDismissedAt),
          // Transcripts may have missed events while the socket was down, so the
          // open session reloads (SessionView re-sends loadTranscript on `hello`).
          // Keep the cached events until that reply lands — the `transcript`
          // handler below merges and dedupes by seq — because blanking them here
          // made every reconnect re-render from empty and re-download megabytes,
          // which on a large transcript stalls the main thread into another
          // heartbeat timeout: reconnect loop. Skipped entirely on a repeat, where
          // there is by definition nothing new to reload.
          ...(repeat ? {} : { transcriptLoaded: {}, contextBreakdowns: {} }),
          };
        });
        const sessions = get().sessions;
        const { selectedSessionId } = get();
        if (selectedSessionId && !sessions[selectedSessionId]) {
          set({ selectedSessionId: null });
        }
        // A cold launch at `/` restores the tab but nothing ever picked a session
        // for it — `projects` only arrives on change. Run the tab's own pick
        // (remembered, else top sidebar row). Not while a create is pending: its
        // claim hands the selection to the new session instead.
        {
          const { activeProject, pendingCreate } = get();
          if (fromPrimary && activeProject && !get().selectedSessionId && !pendingCreate) {
            get().setActiveProject(activeProject);
          }
        }
        // Scoped to THIS machine's sessions. Unscoped, one machine's hello deletes
        // the drafts of another machine's sessions — unsent text the user typed,
        // which nothing can recover. See prunableDraftIds for the exact rule.
        const live = new Set(Object.keys(incoming));
        const doomed = prunableDraftIds({
          draftIds: draftSessionIds(),
          sessionMachine: get().sessionMachine,
          deviceId: from,
          live,
        });
        pruneDrafts(new Set(doomed));
        prunePlanComments(new Set(doomed));
        void pruneDraftAttachments(new Set(doomed));
        // Owner connections only: a guest's hello carries no account-wide field,
        // and adopting somebody else's machine id here would stamp this user's
        // own library with it.
        if (!msg.access) setBridgeOwnerId(msg.userId ?? null);
        if (msg.settings) applySettings(msg.settings);
        // Every owner hello, not just the first: `registerPush` is an idempotent
        // upsert, and this is how a newly linked machine — or one whose file was
        // lost — picks up this device's subscription.
        if (get().alertsEnabled && get().machines[from]?.push) void registerPushWith([from]);
        break;
      }
      case 'settings':
        applySettings(msg.settings);
        break;
      case 'smartRoutingAvailable':
        // Gated like the hello field: it describes the primary machine's key.
        if (fromPrimary) set({ smartRoutingAvailable: msg.available });
        break;
      case 'guardAllowlist':
        set({ guardAllowlist: msg.entries });
        break;
      case 'guardAllowlistReview':
        set((state) => ({
          guardReview: msg.review,
          guardReviewOpen:
            msg.review != null && msg.review.detectedAt !== state.guardReviewDismissedAt,
        }));
        break;
      case 'memoryReview':
        set((state) => ({
          memoryReview: msg.review,
          memoryReviewOpen:
            msg.review != null && msg.review.detectedAt !== state.memoryReviewDismissedAt,
        }));
        break;
      case 'mcpConnections':
        // `?? []`, matching the hello reducer: a bridge that omits the field (or
        // sends it null) must not put `undefined` where the settings list maps
        // over rows and reads `.enabled` off each one.
        set({ mcpConnections: msg.connections ?? [] });
        break;
      case 'mcpConnectionsReview':
        set((state) => ({
          mcpReview: msg.review,
          mcpReviewOpen:
            msg.review != null && msg.review.detectedAt !== state.mcpReviewDismissedAt,
        }));
        break;
      case 'mcpServerStatus':
        set((state) => ({
          mcpStatus: { ...state.mcpStatus, [msg.sessionId]: msg.servers },
        }));
        break;
      // Several sessions at once, after a connection edit reached their live
      // queries — so the pane reflects an add or a toggle without a refresh.
      case 'mcpStatuses':
        set((state) => ({ mcpStatus: { ...state.mcpStatus, ...msg.statuses } }));
        break;
      case 'mcpAuthStarted':
        set((state) => ({
          mcpAuth: {
            ...state.mcpAuth,
            // Three outcomes, and already-authorized is a success: the CLI holds
            // a token for this server, so there is no URL to offer and nothing
            // failed.
            [msg.name]: msg.authUrl
              ? { authUrl: msg.authUrl }
              : msg.alreadyAuthorized
                ? { alreadyAuthorized: true }
                : { error: msg.error },
          },
        }));
        break;
      case 'mcpAuthCompleted':
        set((state) => ({
          mcpAuth: {
            ...state.mcpAuth,
            [msg.name]: msg.ok ? { ok: true } : { error: msg.error },
          },
          // The exchange re-reads status as its last step, so adopt it rather
          // than making the pane ask again.
          mcpStatus: msg.servers
            ? { ...state.mcpStatus, [msg.sessionId]: msg.servers }
            : state.mcpStatus,
        }));
        break;
      // Both describe one machine, and since a machine share receives them too
      // (see `mayReceive`) they can arrive from a machine that is not on screen:
      // the slice always takes them, the globals only from the primary.
      case 'projectKeys': {
        const slice = get().machines[from];
        if (slice) {
          set((state) => ({
            machines: {
              ...state.machines,
              [from]: { ...slice, view: { ...slice.view, projectKeys: msg.projectKeys } },
            },
          }));
        }
        if (fromPrimary) set({ projectKeys: msg.projectKeys });
        break;
      }
      case 'projects': {
        const projects = toProjects(msg.projects);
        const slice = get().machines[from];
        if (slice) {
          set((state) => ({
            machines: { ...state.machines, [from]: { ...slice, view: { ...slice.view, projects } } },
          }));
        }
        if (!fromPrimary) break;
        const before = new Set(get().projects.flatMap(worktreePaths));
        const grew = projects.flatMap(worktreePaths).some((p) => !before.has(p));
        set({ projects });
        // The work tree the pending create asked for has landed, so the create
        // intent is re-armed here: the server broadcasts `projects` immediately
        // before creating the session, and a slow `worktree add` can otherwise
        // outlive CREATE_INTENT_TTL_MS and leave the selection behind.
        if (get().worktreePending && grew) {
          set({ worktreePending: false });
          get().markSessionCreatePending();
        }
        // Re-validate the active tab (it may have just been closed).
        get().setActiveProject(pickActive(projects, get().activeProject));
        break;
      }
      case 'sessionUpsert': {
        const prev = get().sessions[msg.session.id];
        set((state) => {
          // Auto-select on explicit intent, not on a clock. `createdAt` is stamped on
          // the bridge machine: hosted, that is a different computer, and a bridge
          // clock even slightly ahead made every upsert look "just created" — so any
          // session re-entering the map stole the selection. `seenSessionIds` is the
          // other half: a session this browser already knows is never new again.
          // Plus the machine: a session created on a machine the user is not
          // looking at must never pull their view across to it.
          const claim = shouldClaimSelection({
            fromPrimary,
            pendingCreate: state.pendingCreate,
            alreadySeen: state.seenSessionIds.has(msg.session.id),
          });
          return {
            sessions: { ...state.sessions, [msg.session.id]: msg.session },
            // Stamped from the link it arrived on, so `send` can route this
            // session's messages back to the machine that actually hosts it.
            sessionMachine: { ...state.sessionMachine, [msg.session.id]: from },
            seenSessionIds: withSeen(state.seenSessionIds, [msg.session.id]),
            pendingCreate: claim ? false : state.pendingCreate,
            selectedSessionId: claim ? msg.session.id : state.selectedSessionId,
            focusComposerFor: claim ? msg.session.id : state.focusComposerFor,
          };
        });
        maybeAlert(prev, msg.session, {
          enabled: get().alertsEnabled,
          sound: get().alertSound,
          selectedSessionId: get().selectedSessionId,
          onClickNotification: () => get().openSessionFromAlert(msg.session.id),
        });
        break;
      }
      case 'contextBreakdown':
        set((state) => ({
          contextBreakdowns: {
            ...state.contextBreakdowns,
            [msg.sessionId]: { breakdown: msg.breakdown, at: Date.now(), loading: false },
          },
        }));
        break;
      case 'sessionDeleted':
        set((state) => {
          const sessions = { ...state.sessions };
          delete sessions[msg.sessionId];
          const transcripts = { ...state.transcripts };
          delete transcripts[msg.sessionId];
          const lastEventAt = { ...state.lastEventAt };
          delete lastEventAt[msg.sessionId];
          const contextBreakdowns = { ...state.contextBreakdowns };
          delete contextBreakdowns[msg.sessionId];
          return {
            sessions,
            transcripts,
            lastEventAt,
            contextBreakdowns,
            selectedSessionId:
              state.selectedSessionId === msg.sessionId ? null : state.selectedSessionId,
          };
        });
        break;
      // Per machine, like `projects`: a machine share receives the host's library
      // too (see `mayReceive`), and it must not overwrite the globals while
      // another machine is on screen.
      case 'workflows': {
        const slice = get().machines[from];
        if (slice) {
          set((state) => ({
            machines: { ...state.machines, [from]: { ...slice, view: { ...slice.view, workflows: msg.workflows } } },
          }));
        }
        if (fromPrimary) set({ workflows: msg.workflows });
        break;
      }
      case 'sharedWorkflows': {
        const slice = get().machines[from];
        if (slice) {
          set((state) => ({
            machines: {
              ...state.machines,
              [from]: { ...slice, view: { ...slice.view, sharedWorkflows: msg.workflows } },
            },
          }));
        }
        if (fromPrimary) set({ sharedWorkflows: msg.workflows });
        break;
      }
      case 'steps':
        set({ steps: msg.steps });
        break;
      case 'sharedSteps':
        set({ sharedSteps: msg.sharedSteps, pinnedSteps: msg.pinnedSteps });
        break;
      case 'stepVersions':
        set((state) => ({
          stepVersions: { ...state.stepVersions, [`${msg.ownerId}/${msg.stepId}`]: msg.versions },
        }));
        break;
      case 'recipes':
        set({ recipes: msg.recipes });
        break;
      case 'sharedRecipes':
        set({ sharedRecipes: msg.sharedRecipes });
        break;
      case 'recipeVersions':
        set((state) => ({
          recipeVersions: { ...state.recipeVersions, [`${msg.ownerId}/${msg.recipeId}`]: msg.versions },
        }));
        break;
      case 'recipeStats':
        // Partial by contract — a replace would blank every count the push omits.
        set((state) => ({ recipeStats: { ...state.recipeStats, ...msg.stats } }));
        break;
      case 'recipeImageUploaded':
        set((state) => ({
          recipeUploads: {
            ...state.recipeUploads,
            [msg.uploadId]: { ...state.recipeUploads[msg.uploadId], name: state.recipeUploads[msg.uploadId]?.name ?? '', url: msg.url },
          },
        }));
        break;
      case 'recipeRun':
        // Deterministic selection: the run's session id, rather than leaning on
        // `sessionUpsert`'s just-created heuristic (which a slow spawn loses).
        set({ selectedSessionId: msg.sessionId });
        break;
      case 'event': {
        // Buffered, not applied: flushPendingEvents does the dedupe, the
        // supersede rule and the single `set()` one animation frame from now.
        const batch = pendingEvents.get(msg.sessionId);
        if (batch) batch.push(msg.event);
        else pendingEvents.set(msg.sessionId, [msg.event]);
        scheduleFlush();
        break;
      }
      case 'transcript':
        set((state) => {
          const live = state.transcripts[msg.sessionId] ?? [];
          const merged = [...msg.events];
          const seen = new Set(merged.map((e) => e.seq));
          for (const e of live) if (!seen.has(e.seq)) merged.push(e);
          merged.sort((a, b) => a.seq - b.seq);
          // Seed the last-activity clock from history, but never move it backwards.
          const lastTs = merged.length > 0 ? merged[merged.length - 1].ts : 0;
          const lastEventAt = Math.max(state.lastEventAt[msg.sessionId] ?? 0, lastTs);
          return {
            transcripts: { ...state.transcripts, [msg.sessionId]: merged },
            transcriptLoaded: { ...state.transcriptLoaded, [msg.sessionId]: true },
            ...(lastEventAt > 0
              ? { lastEventAt: { ...state.lastEventAt, [msg.sessionId]: lastEventAt } }
              : {}),
          };
        });
        break;
      case 'transcriptTruncated':
        // Dropped locally rather than re-fetched: `case 'transcript'` above MERGES
        // by seq with whatever is in state, so a plain reload would fold the stale
        // tail straight back in. The buffer was already drained at the top of
        // applyServerMessage, so no pending batch can resurrect it either.
        set((state) => {
          const existing = state.transcripts[msg.sessionId];
          if (!existing) return state;
          return {
            transcripts: {
              ...state.transcripts,
              [msg.sessionId]: existing.filter((e) => e.seq < msg.seq),
            },
          };
        });
        break;
      case 'rewound':
        // Stashed, not applied: the composer for this session picks it up (and
        // clears it) via takeComposerPrefill.
        set((state) => ({
          composerPrefill: { ...state.composerPrefill, [msg.sessionId]: msg.prompt },
        }));
        break;
      case 'usage':
        set({ usage: msg.usage });
        break;
      case 'openaiUsage':
        set({ openaiUsage: msg.usage });
        break;
      case 'spendDay':
        // Whole-row replace, never a merge: the bridge sends the day as it now
        // stands, so a message dropped while the tab was asleep self-heals on
        // the next turn. Ignored from anything but the primary — the ledger
        // describes one machine and must not be crossed with another's.
        if (fromPrimary) {
          set((state) => ({
            spendHistory: {
              v: 1,
              tz: state.spendHistory?.tz ?? '',
              days: { ...state.spendHistory?.days, [msg.day]: msg.spend },
            },
          }));
        }
        break;
      case 'authStatus':
        // Success closes the modal; a logout (or dead refresh token) reopens it.
        set(
          msg.auth.loggedIn || get().access
            ? { auth: msg.auth, loginModalOpen: false, authorizeUrl: null, authError: null }
            : { auth: msg.auth, loginModalOpen: true },
        );
        break;
      case 'presence':
        set((state) => {
          const profiles = { ...state.profiles };
          for (const viewer of msg.viewers) {
            // Only entries that actually carry a label: an all-null profile is no
            // better than not knowing, and would shadow a good one learned later.
            if (viewer.profile && (viewer.profile.name || viewer.profile.email)) {
              profiles[viewer.userId] = viewer.profile;
            }
          }
          return { presence: { ...state.presence, [msg.sessionId]: msg.viewers }, profiles };
        });
        break;
      case 'storageStatus':
        set((state) => ({
          machines: {
            ...state.machines,
            [from]: { ...(state.machines[from] ?? emptyMachine(from)), storage: msg.storage },
          },
          // Only the machine in front of the user drives the banner, whose
          // "exactly one at a time" precedence is scoped to it by design.
          ...(fromPrimary ? { storageStatus: msg.storage } : {}),
        }));
        break;
      case 'workerStatus':
        set((state) => ({
          machines: {
            ...state.machines,
            [from]: { ...(state.machines[from] ?? emptyMachine(from)), worker: msg.worker },
          },
          ...(fromPrimary ? { workerStatus: msg.worker } : {}),
        }));
        break;
      case 'cliStatus':
        // Same per-machine shape `workerStatus` uses: the slice for the machine
        // it came from, and the top-level copy only when that machine is the one
        // the UI is pointed at.
        set((state) => ({
          machines: {
            ...state.machines,
            [from]: {
              ...(state.machines[from] ?? emptyMachine(from)),
              claudeCli: msg.claudeCli,
              codexCli: msg.codexCli,
              whisper: msg.whisper ?? null,
            },
          },
          ...(fromPrimary
            ? { claudeCli: msg.claudeCli, codexCli: msg.codexCli, whisper: msg.whisper ?? null }
            : {}),
        }));
        break;
      case 'whisperModelDownload':
        // Primary only, like the pane that shows it.
        if (fromPrimary) set({ whisperModelDownload: msg.status });
        break;
      case 'updateStatus':
        set((state) => ({
          machines: {
            ...state.machines,
            [from]: { ...(state.machines[from] ?? emptyMachine(from)), update: msg.status },
          },
          ...(fromPrimary ? { updateStatus: msg.status } : {}),
        }));
        break;
      case 'authLoginStarted':
        set({ authorizeUrl: msg.authorizeUrl, authError: null });
        break;
      case 'authError':
        set({ authError: msg.message });
        break;
      case 'openaiAuthStatus':
        // Success closes the modal. A disconnect deliberately does NOT open it —
        // unlike the Claude case, there is no turn this app cannot run without it
        // unless the user picked an OpenAI model, and that refusal says so itself.
        set(
          msg.auth.loggedIn
            ? {
                openaiAuth: msg.auth,
                openaiLoginModalOpen: false,
                openaiUserCode: null,
                openaiVerificationUrl: null,
                openaiAuthError: null,
              }
            : { openaiAuth: msg.auth },
        );
        break;
      case 'openaiLoginStarted':
        set({
          openaiUserCode: msg.userCode,
          openaiVerificationUrl: msg.verificationUrl,
          openaiAuthError: null,
        });
        break;
      case 'openaiAuthError':
        // The code is spent either way: a failure ends the flow server-side, so
        // clearing it puts the modal back on its "Connect" screen.
        set({ openaiAuthError: msg.message, openaiUserCode: null });
        break;
      case 'folderPicked':
        // Cleared even when the pick was cancelled (no `path`), so a stale target
        // can't turn the next plain "Browse…" into an add-root.
        set({ folderPickPending: false, folderPickTarget: null });
        break;
      case 'error':
        if (msg.rejectedPrompt) {
          const rejected = msg.rejectedPrompt;
          const current = readDraft(rejected.sessionId);
          const text = [rejected.text, current.text].filter(Boolean).join('\n\n');
          writeDraft(rejected.sessionId, { text, ranges: [] });
          const restored = new CustomEvent('lines:prompt-restored', { detail: rejected, cancelable: true });
          window.dispatchEvent(restored);
          if (!restored.defaultPrevented) {
            void readDraftAttachments(rejected.sessionId).then((existing) =>
              writeDraftAttachments(rejected.sessionId, [...(rejected.attachments ?? []), ...existing]));
          }
        }
        console.error('[server]', msg.message);
        // Surfaced, not just logged: a server refusal is the only description of
        // what would have been lost (a dirty work tree, a branch that isn't merged),
        // and it used to be console-only — which is how "Remove did nothing" stayed
        // invisible. Also retires the same silence for compactContext/addGuardAllow.
        set({ actionError: msg.message, worktreePending: false });
        break;
    }
    // Keep the app/dock badge and favicon in sync with session state.
    const sessions = get().sessions;
    setBadge(countAttention(sessions));
    updateFavicon({ attention: countAttention(sessions), running: countRunning(sessions) > 0 });
  },
  };
});

// Derived state, maintained here rather than at each mutation site: session
// status, project membership and which project is open all move independently,
// and every one of them can change what counts as "seen".
useStore.subscribe((state, prev) => {
  if (
    state.sessions === prev.sessions &&
    state.projectKeys === prev.projectKeys &&
    state.projects === prev.projects &&
    state.activeProject === prev.activeProject &&
    state.sessionMachine === prev.sessionMachine &&
    state.primaryDeviceId === prev.primaryDeviceId
  ) {
    return;
  }
  const next = reconcileSeenStatus(
    state.seenSessionStatus,
    // Scoped to the machine in front of the user, exactly as the sidebar is: a
    // project tab must not pulse for a session its own list no longer shows.
    sessionsOnMachine(state.sessions, state.sessionMachine, state.primaryDeviceId ?? ''),
    state.projectKeys,
    // Extra roots widen membership, so the open project's own shape matters here.
    projectAt(state.projects, state.activeProject),
  );
  // Bail on no-op writes: this listener would otherwise re-enter on its own set.
  if (!sameStringMap(next, state.seenSessionStatus)) useStore.setState({ seenSessionStatus: next });
});

// What `setActiveProject` returns to: recorded here, off the one field, rather
// than at every call site that selects a session.
useStore.subscribe((state, prev) => {
  if (state.selectedSessionId === prev.selectedSessionId || !state.selectedSessionId) return;
  const project = projectAt(state.projects, state.activeProject);
  if (!project) return;
  const id = state.selectedSessionId;
  if (sessionsInProject(state.sessions, state.projectKeys, project).some((s) => s.id === id)) {
    writeLastSession(project.path, id);
  }
});
