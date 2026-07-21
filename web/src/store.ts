import { create } from 'zustand';
import type {
  ModelOption,
  ServerMessage,
  SessionMeta,
  TranscriptEvent,
  WorkflowDef,
} from '@claude-ui/shared';

const ACTIVE_PROJECT_KEY = 'claude-ui.activeProject';

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

  applyServerMessage: (msg: ServerMessage) => void;
  setConnected: (connected: boolean) => void;
  selectSession: (id: string | null) => void;
  setActiveProject: (path: string | null) => void;
  setFolderPickPending: (pending: boolean) => void;
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

  setConnected: (connected) => set({ connected }),
  selectSession: (id) => set({ selectedSessionId: id }),
  setFolderPickPending: (pending) => set({ folderPickPending: pending }),

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
      case 'sessionUpsert':
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
        break;
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
      case 'folderPicked':
        set({ folderPickPending: false });
        break;
      case 'error':
        console.error('[server]', msg.message);
        break;
    }
  },
}));
