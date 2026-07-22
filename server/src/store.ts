import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { SessionMeta, TranscriptEvent, WorkflowDef } from '@claude-ui/shared';

const ROOT = path.join(os.homedir(), '.claude-ui');
const TRANSCRIPTS = path.join(ROOT, 'transcripts');
const ATTACHMENTS = path.join(ROOT, 'attachments');
const SESSIONS_FILE = path.join(ROOT, 'sessions.json');
const WORKFLOWS_FILE = path.join(ROOT, 'workflows.json');
const RECENT_DIRS_FILE = path.join(ROOT, 'recent-dirs.json');
const PROJECTS_FILE = path.join(ROOT, 'projects.json');
const AUTH_FILE = path.join(ROOT, 'auth.json');

fs.mkdirSync(TRANSCRIPTS, { recursive: true });
fs.mkdirSync(ATTACHMENTS, { recursive: true });

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

/** Persisted app-managed Claude OAuth credentials. Written 0600 (tokens are secrets). */
export interface StoredAuth {
  version: 1;
  accessToken: string;
  refreshToken: string;
  /** ms epoch when the access token expires. */
  expiresAt: number;
  scopes: string[];
  account?: { email?: string; organization?: string };
}

export const store = {
  loadSessions(): SessionMeta[] {
    // In-flight statuses may still be true — the worker process holds queries
    // across bridge restarts. reconcileWithWorker() clears the stale ones.
    return readJson<SessionMeta[]>(SESSIONS_FILE, []);
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
    fs.rmSync(path.join(ATTACHMENTS, sessionId), { recursive: true, force: true });
  },

  /** Persist an attachment's base64 to disk; returns the stored file basename. */
  saveAttachment(sessionId: string, name: string, base64: string): string {
    const dir = path.join(ATTACHMENTS, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const safe = name.replace(/[^\w.-]/g, '_') || 'file';
    const file = `${randomUUID()}-${safe}`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(base64, 'base64'));
    return file;
  },

  /** Read a previously staged attachment back to base64; null if the file is gone. */
  loadAttachmentBase64(sessionId: string, file: string): string | null {
    try {
      return fs.readFileSync(path.join(ATTACHMENTS, sessionId, file)).toString('base64');
    } catch {
      return null;
    }
  },

  loadAuth(): StoredAuth | null {
    const auth = readJson<StoredAuth | null>(AUTH_FILE, null);
    return auth && auth.accessToken && auth.refreshToken ? auth : null;
  },

  saveAuth(auth: StoredAuth) {
    // mode only applies at creation, so chmod too in case the file already exists.
    fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(AUTH_FILE, 0o600);
    } catch {
      // best-effort on platforms without POSIX perms
    }
  },

  deleteAuth() {
    fs.rmSync(AUTH_FILE, { force: true });
  },

  loadGuardAllowlist<T>(fallback: T): T {
    return readJson(path.join(ROOT, 'guard-allowlist.json'), fallback);
  },

  saveGuardAllowlist(entries: unknown) {
    writeJson(path.join(ROOT, 'guard-allowlist.json'), entries);
  },

  rootDir: ROOT,
  attachmentsRoot: ATTACHMENTS,
};
