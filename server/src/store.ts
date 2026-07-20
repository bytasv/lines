import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SessionMeta, TranscriptEvent, WorkflowDef } from '@claude-ui/shared';

const ROOT = path.join(os.homedir(), '.claude-ui');
const TRANSCRIPTS = path.join(ROOT, 'transcripts');
const SESSIONS_FILE = path.join(ROOT, 'sessions.json');
const WORKFLOWS_FILE = path.join(ROOT, 'workflows.json');
const RECENT_DIRS_FILE = path.join(ROOT, 'recent-dirs.json');
const PROJECTS_FILE = path.join(ROOT, 'projects.json');

fs.mkdirSync(TRANSCRIPTS, { recursive: true });

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export const store = {
  loadSessions(): SessionMeta[] {
    const sessions = readJson<SessionMeta[]>(SESSIONS_FILE, []);
    // A restarted server has no live queries; anything mid-flight is now idle.
    for (const s of sessions) {
      if (s.status === 'running' || s.status === 'waiting-permission') s.status = 'idle';
    }
    return sessions;
  },

  saveSessions(sessions: SessionMeta[]) {
    writeJson(SESSIONS_FILE, sessions);
  },

  loadWorkflows(): WorkflowDef[] {
    return readJson<WorkflowDef[]>(WORKFLOWS_FILE, []);
  },

  saveWorkflows(workflows: WorkflowDef[]) {
    writeJson(WORKFLOWS_FILE, workflows);
  },

  loadRecentDirs(): string[] {
    return readJson<string[]>(RECENT_DIRS_FILE, []);
  },

  addRecentDir(dir: string) {
    const dirs = store.loadRecentDirs().filter((d) => d !== dir);
    dirs.unshift(dir);
    writeJson(RECENT_DIRS_FILE, dirs.slice(0, 10));
  },

  loadProjects(): string[] {
    return readJson<string[]>(PROJECTS_FILE, []);
  },

  saveProjects(projects: string[]) {
    writeJson(PROJECTS_FILE, projects);
  },

  appendTranscript(sessionId: string, event: TranscriptEvent) {
    fs.appendFileSync(path.join(TRANSCRIPTS, `${sessionId}.jsonl`), JSON.stringify(event) + '\n');
  },

  loadTranscript(sessionId: string): TranscriptEvent[] {
    const file = path.join(TRANSCRIPTS, `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as TranscriptEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is TranscriptEvent => e !== null);
  },

  deleteTranscript(sessionId: string) {
    fs.rmSync(path.join(TRANSCRIPTS, `${sessionId}.jsonl`), { force: true });
  },

  loadGuardAllowlist<T>(fallback: T): T {
    return readJson(path.join(ROOT, 'guard-allowlist.json'), fallback);
  },

  saveGuardAllowlist(entries: unknown) {
    writeJson(path.join(ROOT, 'guard-allowlist.json'), entries);
  },

  rootDir: ROOT,
};
