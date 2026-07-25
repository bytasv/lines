import { create } from 'zustand';
import type {
  AuthStatus,
  ModelOption,
  PermissionMode,
  ProjectKeyMap,
  PromptAttachment,
  PromptMention,
  ServerMessage,
  SessionMeta,
  StepDef,
  StorageStatus,
  TranscriptEvent,
  UsageSnapshot,
  UserUiSettings,
  WorkflowDef,
} from '@lines/shared';
import { DEFAULT_MODEL, resolveModelId } from '@lines/shared';
import { send } from './ws';
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
import { updateFavicon } from './lib/favicon';
import type { MentionValue } from './lib/mentions';

const ACTIVE_PROJECT_KEY = 'lines.activeProject';
const NEW_SESSION_DEFAULTS_KEY = 'lines.newSessionDefaults';
const SIDEBAR_MODE_KEY = 'lines.sidebarMode';
const OPEN_FILES_KEY = 'lines.openFiles';
const COMPACTION_LEVEL_KEY = 'lines.compactionLevel';
const TURN_SUMMARIES_ENABLED_KEY = 'lines.turnSummariesEnabled';
const DISMISSED_CHECKOUTS_KEY = 'lines.dismissedCheckouts';
const DRAFTS_KEY = 'lines.drafts';

export type SidebarMode = 'sessions' | 'files';

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

function loadCompactionLevel(): CompactionLevel {
  const v = localStorage.getItem(COMPACTION_LEVEL_KEY);
  return v === 'full' || v === 'grouped' || v === 'compact' ? v : 'compact';
}

function loadTurnSummariesEnabled(): boolean {
  return localStorage.getItem(TURN_SUMMARIES_ENABLED_KEY) !== 'false';
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

/** Drop drafts for sessions that no longer exist (called on each `hello`). */
function pruneDrafts(liveSessionIds: Set<string>) {
  const drafts = loadDrafts();
  let changed = false;
  for (const id of Object.keys(drafts)) {
    if (!liveSessionIds.has(id)) {
      delete drafts[id];
      changed = true;
    }
  }
  if (changed) localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
}

export interface NewSessionDefaults {
  model: string;
  permissionMode: PermissionMode;
}

function loadNewSessionDefaults(): NewSessionDefaults {
  const fallback: NewSessionDefaults = { model: DEFAULT_MODEL, permissionMode: 'default' };
  try {
    const raw = localStorage.getItem(NEW_SESSION_DEFAULTS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      model: typeof parsed.model === 'string' ? resolveModelId(parsed.model) : fallback.model,
      permissionMode:
        typeof parsed.permissionMode === 'string' ? parsed.permissionMode : fallback.permissionMode,
    };
  } catch {
    return fallback;
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

function pickActive(projects: string[], current: string | null): string | null {
  if (current && projects.includes(current)) return current;
  return projects[0] ?? null;
}

/**
 * Sessions that belong to the active project.
 *
 * Matching is by project key when the active checkout has one, so a session
 * created on another machine — where the same repo sits at a different absolute
 * path — still lands in this project. Unkeyed checkouts (no git remote) fall
 * back to exact path equality, which is the old behaviour.
 */
export function sessionsInProject(
  sessions: Record<string, SessionMeta>,
  projectKeys: ProjectKeyMap,
  activeProject: string | null,
): SessionMeta[] {
  if (!activeProject) return [];
  const activeKey = projectKeys[activeProject];
  return Object.values(sessions).filter(
    (s) => s.cwd === activeProject || (activeKey != null && projectKeys[s.cwd] === activeKey),
  );
}

/** Most recently created session in the given directory, if any. */
function latestSessionIn(sessions: Record<string, SessionMeta>, cwd: string): SessionMeta | undefined {
  return Object.values(sessions)
    .filter((s) => s.cwd === cwd)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

interface UiState {
  connectionStatus: ConnectionStatus;
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
  models: ModelOption[];
  recentDirs: string[];
  /** Open project folders, shown as tabs. */
  projects: string[];
  /** cwd -> machine-independent project identity; see ProjectKeyMap. */
  projectKeys: ProjectKeyMap;
  /** Unresolvable cwds the user marked as "not my project"; hidden from the link hint. */
  dismissedCheckouts: string[];
  /** Project whose sessions are shown; new sessions run here. */
  activeProject: string | null;
  transcripts: Record<string, TranscriptEvent[]>;
  /** Sessions whose on-disk transcript has been requested/loaded. */
  transcriptLoaded: Record<string, boolean>;
  /** ms epoch of the last event seen per session (not persisted) — wedged-agent detection. */
  lastEventAt: Record<string, number>;
  selectedSessionId: string | null;
  folderPickPending: boolean;
  /** Model/mode applied to newly created sessions; persisted in localStorage. */
  newSessionDefaults: NewSessionDefaults;
  /** Play a chime + desktop notification when a session finishes or needs input. */
  alertsEnabled: boolean;
  alertSound: AlertSound;
  notifyPermission: NotificationPermission;
  /** File the preview modal is showing; null when closed. */
  filePreview: { path: string; display: string; line?: number; col?: number } | null;
  /** Claude-plan usage snapshot from the bridge; null when unavailable (API-key users). */
  usage: UsageSnapshot | null;
  /** App login state from the bridge; null until the first `hello`. */
  auth: AuthStatus | null;
  /** Bridge->storage/Supabase link health; null until first `hello`. `available: false` shows the sync-degraded banner. */
  storageStatus: StorageStatus | null;
  /** Authorize URL of the in-progress login, set once the server answers authStartLogin. */
  authorizeUrl: string | null;
  /** Last login failure, shown inline in the login modal. */
  authError: string | null;
  loginModalOpen: boolean;
  /** What the left sidebar shows: session list or project file tree. */
  sidebarMode: SidebarMode;
  /** Transcript compaction level; persisted in localStorage. */
  compactionLevel: CompactionLevel;
  /** Show server-generated 1-2 sentence turn summaries in Compact view; off shows agent narration instead. */
  turnSummariesEnabled: boolean;
  /** Open editor tabs per project path; persisted in localStorage. */
  openFiles: Record<string, OpenFilesState>;

  applyServerMessage: (msg: ServerMessage) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  enqueuePrompt: (p: QueuedPrompt) => void;
  /** Return and clear the queue atomically; caller re-sends the drained prompts. */
  drainQueuedPrompts: () => QueuedPrompt[];
  selectSession: (id: string | null) => void;
  setActiveProject: (path: string | null) => void;
  setFolderPickPending: (pending: boolean) => void;
  setNewSessionDefaults: (defaults: NewSessionDefaults) => void;
  /** Hide (or restore) an unresolvable checkout in the link hint. */
  setCheckoutDismissed: (cwd: string, dismissed: boolean) => void;
  setAlertsEnabled: (on: boolean) => Promise<void>;
  setAlertSound: (sound: AlertSound) => void;
  testAlertSound: () => void;
  openFilePreview: (raw: string) => void;
  closeFilePreview: () => void;
  openLoginModal: () => void;
  closeLoginModal: () => void;
  setSidebarMode: (mode: SidebarMode) => void;
  setCompactionLevel: (level: CompactionLevel) => void;
  setTurnSummariesEnabled: (on: boolean) => void;
  openFileTab: (path: string) => void;
  closeFileTab: (path: string) => void;
  setActiveFileTab: (path: string) => void;
}

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
        alertsEnabled: s.alertsEnabled,
        alertSound: s.alertSound,
        dismissedCheckouts: s.dismissedCheckouts,
        updatedAt: Date.now(),
      },
    });
  };

  /** Apply settings from the server (hello or another tab/instance) without re-sending. */
  const applySettings = (s: UserUiSettings) => {
    set((state) => ({
      newSessionDefaults: s.newSessionDefaults ?? state.newSessionDefaults,
      sidebarMode: s.sidebarMode ?? state.sidebarMode,
      compactionLevel: s.compactionLevel ?? state.compactionLevel,
      turnSummariesEnabled: s.turnSummariesEnabled ?? state.turnSummariesEnabled,
      alertsEnabled: s.alertsEnabled ?? state.alertsEnabled,
      alertSound: (s.alertSound as AlertSound | undefined) ?? state.alertSound,
      dismissedCheckouts: s.dismissedCheckouts ?? state.dismissedCheckouts,
    }));
    // Keep the offline caches current so a cold start matches the server.
    if (s.newSessionDefaults) localStorage.setItem(NEW_SESSION_DEFAULTS_KEY, JSON.stringify(s.newSessionDefaults));
    if (s.sidebarMode) localStorage.setItem(SIDEBAR_MODE_KEY, s.sidebarMode);
    if (s.compactionLevel) localStorage.setItem(COMPACTION_LEVEL_KEY, s.compactionLevel);
    if (s.turnSummariesEnabled != null) localStorage.setItem(TURN_SUMMARIES_ENABLED_KEY, String(s.turnSummariesEnabled));
    if (s.alertsEnabled != null) persistAlertsEnabled(s.alertsEnabled);
    if (s.alertSound) persistAlertSound(s.alertSound as AlertSound);
    if (s.dismissedCheckouts) {
      localStorage.setItem(DISMISSED_CHECKOUTS_KEY, JSON.stringify(s.dismissedCheckouts));
    }
  };

  return {
  connectionStatus: 'reconnecting',
  queuedPrompts: [],
  sessions: {},
  workflows: [],
  sharedWorkflows: [],
  steps: [],
  sharedSteps: [],
  pinnedSteps: [],
  stepVersions: {},
  models: [],
  recentDirs: [],
  projects: [],
  projectKeys: {},
  dismissedCheckouts: loadDismissedCheckouts(),
  activeProject: localStorage.getItem(ACTIVE_PROJECT_KEY),
  transcripts: {},
  transcriptLoaded: {},
  lastEventAt: {},
  selectedSessionId: sessionIdFromUrl(),
  folderPickPending: false,
  newSessionDefaults: loadNewSessionDefaults(),
  alertsEnabled: loadAlertsEnabled(),
  alertSound: loadAlertSound(),
  notifyPermission: 'Notification' in window ? Notification.permission : 'denied',
  filePreview: null,
  usage: null,
  auth: null,
  storageStatus: null,
  authorizeUrl: null,
  authError: null,
  loginModalOpen: false,
  sidebarMode: loadSidebarMode(),
  compactionLevel: loadCompactionLevel(),
  turnSummariesEnabled: loadTurnSummariesEnabled(),
  openFiles: loadOpenFiles(),

  setConnectionStatus: (status) => set({ connectionStatus: status }),
  enqueuePrompt: (p) => set((state) => ({ queuedPrompts: [...state.queuedPrompts, p] })),
  drainQueuedPrompts: () => {
    const queued = get().queuedPrompts;
    if (queued.length) set({ queuedPrompts: [] });
    return queued;
  },
  selectSession: (id) => set({ selectedSessionId: id }),
  setFolderPickPending: (pending) => set({ folderPickPending: pending }),

  openFilePreview: (raw) => {
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
    set({ filePreview: { path: resolved, display: rawPath, line, col } });
  },
  closeFilePreview: () => set({ filePreview: null }),

  openLoginModal: () => set({ loginModalOpen: true, authError: null }),
  closeLoginModal: () => set({ loginModalOpen: false, authorizeUrl: null, authError: null }),

  setSidebarMode: (mode) => {
    localStorage.setItem(SIDEBAR_MODE_KEY, mode);
    set({ sidebarMode: mode });
    pushSettings();
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
    } else {
      set({ alertsEnabled: false });
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

  setActiveProject: (path) => {
    if (path) localStorage.setItem(ACTIVE_PROJECT_KEY, path);
    else localStorage.removeItem(ACTIVE_PROJECT_KEY);
    set((state) => {
      let selected = state.selectedSessionId;
      const current = selected ? state.sessions[selected] : undefined;
      if (!path) {
        selected = null;
      } else if (!current || current.cwd !== path) {
        // Switching tabs lands on that project's latest session.
        selected = latestSessionIn(state.sessions, path)?.id ?? null;
      }
      return { activeProject: path, selectedSessionId: selected };
    });
  },

  applyServerMessage: (msg) => {
    switch (msg.type) {
      case 'hello': {
        const sessions: Record<string, SessionMeta> = {};
        for (const s of msg.sessions) sessions[s.id] = s;
        set((state) => ({
          sessions,
          workflows: msg.workflows,
          sharedWorkflows: msg.sharedWorkflows ?? [],
          steps: msg.steps ?? [],
          sharedSteps: msg.sharedSteps ?? [],
          pinnedSteps: msg.pinnedSteps ?? [],
          models: msg.models,
          recentDirs: msg.recentDirs,
          projects: msg.projects,
          projectKeys: msg.projectKeys ?? {},
          usage: msg.usage,
          auth: msg.auth,
          storageStatus: msg.storage ?? null,
          // Logged out? Open the login flow — but only on the first hello with
          // that news, so reconnects don't reopen a dismissed modal.
          loginModalOpen:
            state.loginModalOpen || (!msg.auth.loggedIn && state.auth?.loggedIn !== false),
          activeProject: pickActive(msg.projects, state.activeProject),
          // Live transcripts are stale after a reconnect; force reloads.
          transcripts: {},
          transcriptLoaded: {},
        }));
        const { selectedSessionId } = get();
        if (selectedSessionId && !sessions[selectedSessionId]) {
          set({ selectedSessionId: null });
        }
        pruneDrafts(new Set(Object.keys(sessions)));
        if (msg.settings) applySettings(msg.settings);
        break;
      }
      case 'settings':
        applySettings(msg.settings);
        break;
      case 'projectKeys':
        set({ projectKeys: msg.projectKeys });
        break;
      case 'projects': {
        set({ projects: msg.projects });
        // Re-validate the active tab (it may have just been closed).
        get().setActiveProject(pickActive(msg.projects, get().activeProject));
        break;
      }
      case 'sessionUpsert': {
        const prev = get().sessions[msg.session.id];
        set((state) => {
          const isNew = !state.sessions[msg.session.id];
          const justCreated = Date.now() - msg.session.createdAt < 5000;
          return {
            sessions: { ...state.sessions, [msg.session.id]: msg.session },
            // Auto-select freshly created sessions (single-user local app).
            selectedSessionId:
              isNew && justCreated ? msg.session.id : state.selectedSessionId,
          };
        });
        maybeAlert(prev, msg.session, {
          enabled: get().alertsEnabled,
          sound: get().alertSound,
          selectedSessionId: get().selectedSessionId,
          onClickNotification: () => get().selectSession(msg.session.id),
        });
        break;
      }
      case 'sessionDeleted':
        set((state) => {
          const sessions = { ...state.sessions };
          delete sessions[msg.sessionId];
          const transcripts = { ...state.transcripts };
          delete transcripts[msg.sessionId];
          const lastEventAt = { ...state.lastEventAt };
          delete lastEventAt[msg.sessionId];
          return {
            sessions,
            transcripts,
            lastEventAt,
            selectedSessionId:
              state.selectedSessionId === msg.sessionId ? null : state.selectedSessionId,
          };
        });
        break;
      case 'workflows':
        set({ workflows: msg.workflows });
        break;
      case 'sharedWorkflows':
        set({ sharedWorkflows: msg.workflows });
        break;
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
      case 'event':
        set((state) => {
          const existing = state.transcripts[msg.sessionId] ?? [];
          // Drop duplicates (e.g. history replay racing live events).
          if (existing.some((e) => e.seq === msg.event.seq)) return state;
          // A complete (non-stream) SDK message supersedes the deltas that built
          // up to it — drop them so long turns don't accumulate stream events.
          const isSdkStream = (e: TranscriptEvent) =>
            e.kind === 'sdk' && (e.data as { type?: string } | null)?.type === 'stream_event';
          const base =
            msg.event.kind === 'sdk' && !isSdkStream(msg.event) ? existing.filter((e) => !isSdkStream(e)) : existing;
          return {
            transcripts: { ...state.transcripts, [msg.sessionId]: [...base, msg.event] },
            lastEventAt: { ...state.lastEventAt, [msg.sessionId]: Date.now() },
          };
        });
        break;
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
      case 'usage':
        set({ usage: msg.usage });
        break;
      case 'authStatus':
        // Success closes the modal; a logout (or dead refresh token) reopens it.
        set(
          msg.auth.loggedIn
            ? { auth: msg.auth, loginModalOpen: false, authorizeUrl: null, authError: null }
            : { auth: msg.auth, loginModalOpen: true },
        );
        break;
      case 'storageStatus':
        set({ storageStatus: msg.storage });
        break;
      case 'authLoginStarted':
        set({ authorizeUrl: msg.authorizeUrl, authError: null });
        break;
      case 'authError':
        set({ authError: msg.message });
        break;
      case 'folderPicked':
        set({ folderPickPending: false });
        break;
      case 'error':
        console.error('[server]', msg.message);
        break;
    }
    // Keep the app/dock badge and favicon in sync with session state.
    const sessions = get().sessions;
    setBadge(countAttention(sessions));
    updateFavicon({ attention: countAttention(sessions), running: countRunning(sessions) > 0 });
  },
  };
});
