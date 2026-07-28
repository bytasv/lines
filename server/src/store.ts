import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  GuardAllowEntry,
  ProjectKeyMap,
  SessionMeta,
  StepDef,
  TranscriptEvent,
  UserUiSettings,
  WorkflowDef,
} from '@lines/shared';

/** Guard-allowlist sync bookkeeping, kept beside the entries but never mixed into them:
 *  `updatedAt` orders the storage row (LWW), `pending` is a remote list awaiting review,
 *  `rejected` remembers the remote content a "keep mine" answer already covered. */
export interface GuardSyncState {
  updatedAt: number;
  pending: { entries: GuardAllowEntry[]; remoteUpdatedAt: number; detectedAt: number } | null;
  rejected: { entries: GuardAllowEntry[]; rejectedAt: number } | null;
}

const EMPTY_GUARD_SYNC: GuardSyncState = { updatedAt: 0, pending: null, rejected: null };

/** Machine-global app root. Per-user stores live under `${APP_ROOT}/users/{userId}`;
 * machine-wide assets (vendored plugins) stay directly under this root. */
export const APP_ROOT = path.join(os.homedir(), '.lines-app');

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

/** Cached form of one transcript file. `parsed` is built lazily — most reads
 *  (the wire frame) only ever need the raw lines. */
interface TranscriptEntry {
  /** Whole JSONL lines, each a complete JSON object. */
  lines: string[];
  parsed: TranscriptEvent[] | null;
  mtimeMs: number;
  size: number;
}

/** Cache bounds. The largest transcripts seen in practice are a few MB, so the
 *  byte cap is what actually binds; the count cap keeps the map small. */
const MAX_CACHED_TRANSCRIPTS = 12;
const MAX_CACHED_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

/**
 * Tolerant JSONL split. Keeps only whole JSON objects: a crash mid-append can
 * leave a torn final line, and the raw lines go on the wire unparsed, so a torn
 * line would make the entire frame unparseable for the client (which drops the
 * whole message and never retries). Mirrors loadTranscript's historic
 * parse-and-drop behavior.
 */
function splitJsonl(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line[0] !== '{' || line[line.length - 1] !== '}') continue;
    lines.push(line);
  }
  return lines;
}

/** Last-synced fingerprint per memory file (absolute path -> state). */
export type MemoryManifest = Record<string, { key: string; mtimeMs: number; size: number }>;

/**
 * Storage-server clock reading at the last successful pull, per resource. Sent
 * back as `?since=` so a pull transfers only rows changed since then. These are
 * *server* timestamps, never local ones — the bridge's clock may differ from the
 * database's, and a fast local clock would silently skip rows.
 */
export type SyncWatermarks = Partial<Record<'workflows' | 'steps' | 'sessions' | 'memory', string>>;

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

/**
 * Flat-JSON persistence rooted at a single directory. One store per user
 * (`createStore(userStoreRoot(userId))`); the local disk is a cache/offline
 * fallback for the cloud storage server. Whole-file overwrites, no locking.
 */
export function createStore(root: string) {
  const TRANSCRIPTS = path.join(root, 'transcripts');
  const ATTACHMENTS = path.join(root, 'attachments');
  const SESSIONS_FILE = path.join(root, 'sessions.json');
  const WORKFLOWS_FILE = path.join(root, 'workflows.json');
  const STEPS_FILE = path.join(root, 'steps.json');
  const STEP_VERSIONS_FILE = path.join(root, 'step-versions.json');
  const RECENT_DIRS_FILE = path.join(root, 'recent-dirs.json');
  const PROJECTS_FILE = path.join(root, 'projects.json');
  const PROJECT_KEYS_FILE = path.join(root, 'project-keys.json');
  const AUTH_FILE = path.join(root, 'auth.json');
  const GUARD_FILE = path.join(root, 'guard-allowlist.json');
  // Separate file from GUARD_FILE, which stays a bare GuardAllowEntry[]: wrapping
  // the entries in an envelope would make an older build's loader call .some() on
  // an object and throw on startup.
  const GUARD_SYNC_FILE = path.join(root, 'guard-allowlist-sync.json');
  const SETTINGS_FILE = path.join(root, 'settings.json');
  const MEMORY_MANIFEST_FILE = path.join(root, 'memory-manifest.json');
  const WATERMARKS_FILE = path.join(root, 'sync-watermarks.json');

  fs.mkdirSync(TRANSCRIPTS, { recursive: true });
  fs.mkdirSync(ATTACHMENTS, { recursive: true });

  // Per-session transcript cache. Lives inside createStore so it is per-user,
  // matching the isolation model. This process is the only writer of
  // transcripts/*.jsonl, so appends update the entry in place; the stat
  // revalidation below still covers the offline migrate script and hand-edits.
  const transcriptCache = new Map<string, TranscriptEntry>();

  const transcriptFile = (sessionId: string) => path.join(TRANSCRIPTS, `${sessionId}.jsonl`);

  /** Insertion order is the LRU order: re-insert on hit, evict from the front. */
  function touchEntry(sessionId: string, entry: TranscriptEntry) {
    transcriptCache.delete(sessionId);
    transcriptCache.set(sessionId, entry);
    let bytes = 0;
    for (const e of transcriptCache.values()) bytes += e.size;
    while (
      transcriptCache.size > 1 &&
      (transcriptCache.size > MAX_CACHED_TRANSCRIPTS || bytes > MAX_CACHED_TRANSCRIPT_BYTES)
    ) {
      const oldest = transcriptCache.keys().next();
      if (oldest.done) break;
      bytes -= transcriptCache.get(oldest.value)!.size;
      transcriptCache.delete(oldest.value);
    }
  }

  /** Cached entry for a session, revalidated against the file's mtime/size. */
  function transcriptEntry(sessionId: string): TranscriptEntry | null {
    const file = transcriptFile(sessionId);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      transcriptCache.delete(sessionId);
      return null;
    }
    const cached = transcriptCache.get(sessionId);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      touchEntry(sessionId, cached);
      return cached;
    }
    const entry: TranscriptEntry = {
      lines: splitJsonl(fs.readFileSync(file, 'utf8')),
      parsed: null,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
    touchEntry(sessionId, entry);
    return entry;
  }

  const store = {
    loadSessions(): SessionMeta[] {
      // In-flight statuses may still be true — the worker process holds queries
      // across bridge restarts. reconcileWithWorker() clears the stale ones.
      return readJson<SessionMeta[]>(SESSIONS_FILE, []);
    },

    saveSessions(sessions: SessionMeta[]) {
      // Not pretty-printed: this is the largest and by far the most frequently
      // rewritten state file (every status transition), and nothing reads it by
      // hand. The indentation alone was roughly half the bytes written.
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions));
    },

    loadWorkflows(): WorkflowDef[] {
      return readJson<WorkflowDef[]>(WORKFLOWS_FILE, []);
    },

    saveWorkflows(workflows: WorkflowDef[]) {
      writeJson(WORKFLOWS_FILE, workflows);
    },

    loadSteps(): StepDef[] {
      return readJson<StepDef[]>(STEPS_FILE, []);
    },

    saveSteps(steps: StepDef[]) {
      writeJson(STEPS_FILE, steps);
    },

    // Own steps' full immutable history — heads live in steps.json; this keeps
    // older versions resolvable across restarts when storage is offline.
    loadStepVersions(): StepDef[] {
      return readJson<StepDef[]>(STEP_VERSIONS_FILE, []);
    },

    saveStepVersions(versions: StepDef[]) {
      writeJson(STEP_VERSIONS_FILE, versions);
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

    // `projects` is this machine's open paths (never synced — paths are local).
    // `project-keys` maps those paths to machine-independent identities and IS
    // synced, so other installs can group sessions by repo.
    loadProjectKeys(): ProjectKeyMap {
      return readJson<ProjectKeyMap>(PROJECT_KEYS_FILE, {});
    },

    saveProjectKeys(keys: ProjectKeyMap) {
      writeJson(PROJECT_KEYS_FILE, keys);
    },

    appendTranscript(sessionId: string, event: TranscriptEvent) {
      const line = JSON.stringify(event);
      const file = transcriptFile(sessionId);
      fs.appendFileSync(file, line + '\n');
      // Extend the cached entry rather than invalidating it — re-reading a
      // multi-MB transcript on every appended event is exactly the cost the
      // cache exists to remove.
      const entry = transcriptCache.get(sessionId);
      if (!entry) return;
      entry.lines.push(line);
      entry.parsed?.push(event);
      try {
        const stat = fs.statSync(file);
        entry.mtimeMs = stat.mtimeMs;
        entry.size = stat.size;
      } catch {
        transcriptCache.delete(sessionId);
      }
    },

    /**
     * The transcript's raw JSONL lines, unparsed. Lets the wire frame be built
     * by joining them instead of round-tripping the whole file through
     * JSON.parse + JSON.stringify on the bridge's only thread.
     */
    loadTranscriptRaw(sessionId: string): string[] {
      return transcriptEntry(sessionId)?.lines ?? [];
    },

    loadTranscript(sessionId: string): TranscriptEvent[] {
      const entry = transcriptEntry(sessionId);
      if (!entry) return [];
      if (!entry.parsed) {
        const parsed: TranscriptEvent[] = [];
        for (const line of entry.lines) {
          try {
            parsed.push(JSON.parse(line) as TranscriptEvent);
          } catch {
            // Unparseable line — dropped, as it always has been.
          }
        }
        entry.parsed = parsed;
      }
      // Shared, not copied: every caller only ever reads.
      return entry.parsed;
    },

    deleteTranscript(sessionId: string) {
      transcriptCache.delete(sessionId);
      fs.rmSync(transcriptFile(sessionId), { force: true });
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
      return readJson(GUARD_FILE, fallback);
    },

    loadSettings(): UserUiSettings | null {
      return readJson<UserUiSettings | null>(SETTINGS_FILE, null);
    },

    saveSettings(settings: UserUiSettings) {
      writeJson(SETTINGS_FILE, settings);
    },

    saveGuardAllowlist(entries: unknown) {
      writeJson(GUARD_FILE, entries);
    },

    loadGuardSync(): GuardSyncState {
      const raw = readJson<Partial<GuardSyncState>>(GUARD_SYNC_FILE, EMPTY_GUARD_SYNC);
      return {
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
        pending: raw.pending ?? null,
        rejected: raw.rejected ?? null,
      };
    },

    saveGuardSync(state: GuardSyncState) {
      writeJson(GUARD_SYNC_FILE, state);
    },

    // Last-synced state of every memory file, keyed by absolute path, so the
    // syncer can mtime-diff to find local changes without re-reading everything.
    loadMemoryManifest(): MemoryManifest {
      return readJson<MemoryManifest>(MEMORY_MANIFEST_FILE, {});
    },

    saveMemoryManifest(manifest: MemoryManifest) {
      writeJson(MEMORY_MANIFEST_FILE, manifest);
    },

    // Per-resource delta-sync cursors. Persisted so a bridge restart resumes
    // where it left off instead of re-pulling every row.
    loadSyncWatermarks(): SyncWatermarks {
      return readJson<SyncWatermarks>(WATERMARKS_FILE, {});
    },

    saveSyncWatermarks(marks: SyncWatermarks) {
      writeJson(WATERMARKS_FILE, marks);
    },

    rootDir: root,
    attachmentsRoot: ATTACHMENTS,
  };

  return store;
}

export type Store = ReturnType<typeof createStore>;

/** Directory holding a single user's flat-JSON state. */
export function userStoreRoot(userId: string): string {
  return path.join(APP_ROOT, 'users', userId);
}

