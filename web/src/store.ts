import { create } from 'zustand';
import type {
  ModelOption,
  PermissionMode,
  ServerMessage,
  SessionMeta,
  TranscriptEvent,
  UsageSnapshot,
  WorkflowDef,
} from '@claude-ui/shared';
import { DEFAULT_MODEL } from '@claude-ui/shared';
import type { AlertSound } from './lib/alerts';
import {
  countAttention,
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

const ACTIVE_PROJECT_KEY = 'claude-ui.activeProject';
const NEW_SESSION_DEFAULTS_KEY = 'claude-ui.newSessionDefaults';
const SIDEBAR_MODE_KEY = 'claude-ui.sidebarMode';
const OPEN_FILES_KEY = 'claude-ui.openFiles';

export type SidebarMode = 'sessions' | 'files';

/** Open editor tabs for one project (files mode). */
export interface OpenFilesState {
  tabs: string[];
  active: string | null;
}

function loadSidebarMode(): SidebarMode {
  return localStorage.getItem(SIDEBAR_MODE_KEY) === 'files' ? 'files' : 'sessions';
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
      model: typeof parsed.model === 'string' ? parsed.model : fallback.model,
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

function pickActive(projects: string[], current: string | null): string | null {
  if (current && projects.includes(current)) return current;
  return projects[0] ?? null;
}

/** Most recently created session in the given directory, if any. */
function latestSessionIn(sessions: Record<string, SessionMeta>, cwd: string): SessionMeta | undefined {
  return Object.values(sessions)
    .filter((s) => s.cwd === cwd)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

interface UiState {
  connected: boolean;
  sessions: Record<string, SessionMeta>;
  workflows: WorkflowDef[];
  models: ModelOption[];
  recentDirs: string[];
  /** Open project folders, shown as tabs. */
  projects: string[];
  /** Project whose sessions are shown; new sessions run here. */
  activeProject: string | null;
  transcripts: Record<string, TranscriptEvent[]>;
  /** Sessions whose on-disk transcript has been requested/loaded. */
  transcriptLoaded: Record<string, boolean>;
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
  /** What the left sidebar shows: session list or project file tree. */
  sidebarMode: SidebarMode;
  /** Open editor tabs per project path; persisted in localStorage. */
  openFiles: Record<string, OpenFilesState>;

  applyServerMessage: (msg: ServerMessage) => void;
  setConnected: (connected: boolean) => void;
  selectSession: (id: string | null) => void;
  setActiveProject: (path: string | null) => void;
  setFolderPickPending: (pending: boolean) => void;
  setNewSessionDefaults: (defaults: NewSessionDefaults) => void;
  setAlertsEnabled: (on: boolean) => Promise<void>;
  setAlertSound: (sound: AlertSound) => void;
  testAlertSound: () => void;
  openFilePreview: (raw: string) => void;
  closeFilePreview: () => void;
  setSidebarMode: (mode: SidebarMode) => void;
  openFileTab: (path: string) => void;
  closeFileTab: (path: string) => void;
  setActiveFileTab: (path: string) => void;
}

export const useStore = create<UiState>((set, get) => ({
  connected: false,
  sessions: {},
  workflows: [],
  models: [],
  recentDirs: [],
  projects: [],
  activeProject: localStorage.getItem(ACTIVE_PROJECT_KEY),
  transcripts: {},
  transcriptLoaded: {},
  selectedSessionId: sessionIdFromUrl(),
  folderPickPending: false,
  newSessionDefaults: loadNewSessionDefaults(),
  alertsEnabled: loadAlertsEnabled(),
  alertSound: loadAlertSound(),
  notifyPermission: 'Notification' in window ? Notification.permission : 'denied',
  filePreview: null,
  usage: null,
  sidebarMode: loadSidebarMode(),
  openFiles: loadOpenFiles(),

  setConnected: (connected) => set({ connected }),
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

  setSidebarMode: (mode) => {
    localStorage.setItem(SIDEBAR_MODE_KEY, mode);
    set({ sidebarMode: mode });
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
  },

  setAlertSound: (sound) => {
    persistAlertSound(sound);
    set({ alertSound: sound });
  },

  testAlertSound: () => {
    primeAudio();
    playSound(get().alertSound);
  },

  setNewSessionDefaults: (defaults) => {
    localStorage.setItem(NEW_SESSION_DEFAULTS_KEY, JSON.stringify(defaults));
    set({ newSessionDefaults: defaults });
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
          models: msg.models,
          recentDirs: msg.recentDirs,
          projects: msg.projects,
          usage: msg.usage,
          activeProject: pickActive(msg.projects, state.activeProject),
          // Live transcripts are stale after a reconnect; force reloads.
          transcripts: {},
          transcriptLoaded: {},
        }));
        const { selectedSessionId } = get();
        if (selectedSessionId && !sessions[selectedSessionId]) {
          set({ selectedSessionId: null });
        }
        break;
      }
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
          return {
            sessions,
            transcripts,
            selectedSessionId:
              state.selectedSessionId === msg.sessionId ? null : state.selectedSessionId,
          };
        });
        break;
      case 'workflows':
        set({ workflows: msg.workflows });
        break;
      case 'event':
        set((state) => {
          const existing = state.transcripts[msg.sessionId] ?? [];
          // Drop duplicates (e.g. history replay racing live events).
          if (existing.some((e) => e.seq === msg.event.seq)) return state;
          return {
            transcripts: { ...state.transcripts, [msg.sessionId]: [...existing, msg.event] },
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
          return {
            transcripts: { ...state.transcripts, [msg.sessionId]: merged },
            transcriptLoaded: { ...state.transcriptLoaded, [msg.sessionId]: true },
          };
        });
        break;
      case 'usage':
        set({ usage: msg.usage });
        break;
      case 'folderPicked':
        set({ folderPickPending: false });
        break;
      case 'error':
        console.error('[server]', msg.message);
        break;
    }
    // Keep the app/dock badge in sync with sessions needing attention.
    setBadge(countAttention(get().sessions));
  },
}));
