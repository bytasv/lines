/**
 * Workspace reads requested by the browser: file contents, directory listings,
 * the docs bundle, `@mention` file search, and stored attachments.
 *
 * Pure functions returning `{ status, body }` rather than writing to a
 * `http.ServerResponse`, so they can be driven over the WebSocket (and, later,
 * over a relay channel) with no HTTP anywhere. Kept out of index.ts only so they
 * are importable by their own test — index.ts starts listening on import.
 *
 * `status` keeps using HTTP codes: the client already maps 403/404/413/415 to
 * user-facing messages, and they name these outcomes as well as anything else
 * would.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type {
  FileRequestKind,
  FileRequestParams,
  LineMatcher,
  SessionMeta,
  SessionSearchHit,
  SessionSearchResponse,
  SocketAccess,
} from '@lines/shared';
import { buildMatcher } from '@lines/shared';
import { grepFilesAcross } from './contentSearch.ts';
import { collectDocs } from './docsBundle.ts';
import { searchFilesAcross } from './fileSearch.ts';
import { showFile } from './git.ts';
import { searchSession } from './sessionSearch.ts';
import type { UserContext } from './userContext.ts';
import { resolveWorkspacePath } from './workspacePaths.ts';

export interface FileRouteResult {
  status: number;
  body?: unknown;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const FIND_MAX_LIMIT = 25;

/**
 * Directory entries hidden from the file tree. Dot-entries are not on the list:
 * an editor shows `.github/`, `.claude/`, `.env.example`, and a project whose
 * config lives in dot-directories is otherwise unbrowsable.
 */
const TREE_IGNORE = new Set(['node_modules', '.git']);

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
};

/** The single `paths[0]` every route but `find` and `attachment` takes. */
function soleRoot(ctx: UserContext, params: FileRequestParams, access: SocketAccess): string | null {
  return resolveWorkspacePath(ctx, params.paths?.[0] ?? '', access);
}

/** A workspace file, for the clickable-path preview. */
function readFile(ctx: UserContext, params: FileRequestParams, access: SocketAccess): FileRouteResult {
  const abs = soleRoot(ctx, params, access);
  if (!abs) return { status: 403 };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { status: 404 };
  }
  if (!stat.isFile()) return { status: 404 };
  if (stat.size > MAX_FILE_BYTES) return { status: 413 };
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return { status: 404 };
  }
  // Reject binary files (NUL byte in the first 8KB).
  if (buf.subarray(0, 8192).includes(0)) return { status: 415 };
  return { status: 200, body: { content: buf.toString('utf8') } };
}

/** One directory listing for the sidebar file tree. */
function readTree(ctx: UserContext, params: FileRequestParams, access: SocketAccess): FileRouteResult {
  const abs = soleRoot(ctx, params, access);
  if (!abs) return { status: 403 };
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return { status: 404 };
  }
  const kept = dirents.filter((d) => !TREE_IGNORE.has(d.name) && (d.isDirectory() || d.isFile()));
  const ignored = ignoredNames(abs, kept);
  const entries = kept
    .map((d) => ({
      name: d.name,
      type: d.isDirectory() ? ('dir' as const) : ('file' as const),
      ...(ignored.has(d.name) && { ignored: true }),
    }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { status: 200, body: { entries } };
}

/**
 * Which of `dirents` git ignores, in one `check-ignore` per directory rather
 * than one per entry. An empty set outside a repo (or when git is unavailable),
 * which reads as "nothing is ignored" — the same thing the search side does.
 */
function ignoredNames(dir: string, dirents: fs.Dirent[]): Set<string> {
  if (!dirents.length) return new Set();
  try {
    const out = execFileSync('git', ['-C', dir, 'check-ignore', '--stdin'], {
      input: dirents.map((d) => d.name).join('\n'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return new Set(out.split('\n').filter(Boolean));
  } catch {
    // Exit code 1 means "none of them are ignored", which throws here like any
    // other failure; both answers are the same empty set.
    return new Set();
  }
}

/**
 * A project's whole `docs/**` markdown corpus in one response — the reader's
 * only request. Not cached: the walk is small and the client holds the bundle
 * for the life of the page.
 */
function readDocs(ctx: UserContext, params: FileRequestParams, access: SocketAccess): FileRouteResult {
  const abs = soleRoot(ctx, params, access);
  if (!abs) return { status: 403 };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { status: 404 };
  }
  if (!stat.isDirectory()) return { status: 404 };
  return { status: 200, body: { root: abs, ...collectDocs(abs) } };
}

/** Rank project files by name for the composer's `@mention` search. */
function findFiles(ctx: UserContext, params: FileRequestParams, access: SocketAccess): FileRouteResult {
  // One path per root. Any unresolvable root fails the whole request rather than
  // silently searching the rest: a partial result looks like "no match here" and
  // would quietly hide a whole folder from the mention list.
  const requested = params.paths ?? [];
  const roots = requested.map((raw) => resolveWorkspacePath(ctx, raw, access));
  if (!roots.length || roots.some((root) => root === null)) return { status: 403 };
  const limit = Math.min(params.limit || FIND_MAX_LIMIT, FIND_MAX_LIMIT);
  return {
    status: 200,
    body: {
      files: searchFilesAcross(
        roots as string[],
        params.q ?? '',
        limit,
        params.includeIgnored === true,
      ),
    },
  };
}

/**
 * A 400 that says why. A bare 400 is also what an unknown kind gets — which is
 * exactly what a bridge older than this route answers — so the client must be
 * able to tell "your regex is wrong" from "this bridge can't search".
 */
const INVALID_REGEX: FileRouteResult = { status: 400, body: { error: 'invalidRegex' } };

/**
 * Content search across the project's roots, for the sidebar's Search mode.
 * Same all-or-nothing root rule as {@link findFiles}; an invalid regex is the
 * client's mistake to show, so it is a 400 rather than a 500.
 */
async function grepFiles(
  ctx: UserContext,
  params: FileRequestParams,
  access: SocketAccess,
): Promise<FileRouteResult> {
  const roots = (params.paths ?? []).map((raw) => resolveWorkspacePath(ctx, raw, access));
  if (!roots.length || roots.some((root) => root === null)) return { status: 403 };
  try {
    return {
      status: 200,
      body: await grepFilesAcross(roots as string[], params.q ?? '', {
        caseSensitive: params.caseSensitive,
        regex: params.regex,
        wholeWord: params.wholeWord,
        includeIgnored: params.includeIgnored === true,
      }),
    };
  } catch (err) {
    if (err instanceof SyntaxError) return INVALID_REGEX;
    throw err;
  }
}

const SESSION_SEARCH_PER_SESSION = 50;
const SESSION_SEARCH_MAX_SESSIONS = 100;
const SESSION_SEARCH_BUDGET_MS = 3000;

/**
 * Transcript search over the project's sessions — or over exactly
 * `params.sessionIds` — most recently updated first. Every candidate passes
 * {@link sessionInReach}, so a session-scope guest can never learn what a
 * sibling session said; an id outside the grant is skipped, not an error,
 * because "all sessions" from a guest's sidebar is a list the bridge still
 * clamps.
 */
async function searchSessionsRoute(
  ctx: UserContext,
  params: FileRequestParams,
  access: SocketAccess,
): Promise<FileRouteResult> {
  let match: LineMatcher;
  try {
    match = buildMatcher(params.q ?? '', params);
  } catch (err) {
    if (err instanceof SyntaxError) return INVALID_REGEX;
    throw err;
  }
  let metas: SessionMeta[];
  if (params.sessionIds) {
    metas = params.sessionIds
      .map((id) => ctx.sessions.get(id))
      .filter((s): s is SessionMeta => !!s);
  } else {
    const roots = (params.paths ?? []).map((raw) => resolveWorkspacePath(ctx, raw, access));
    if (!roots.length || roots.some((root) => root === null)) return { status: 403 };
    const under = (cwd: string) =>
      (roots as string[]).some((root) => cwd === root || cwd.startsWith(root + path.sep));
    metas = ctx.sessions.list().filter((s) => under(s.cwd));
  }
  metas = metas
    .filter((s) => sessionInReach(s.id, access))
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
  if (!params.q) return { status: 200, body: { sessions: [] } satisfies SessionSearchResponse };
  const deadline = Date.now() + SESSION_SEARCH_BUDGET_MS;
  const sessions: SessionSearchHit[] = [];
  for (const meta of metas) {
    // One transcript read per session is the unit of work; yield between them
    // so a project with hundreds of long sessions does not stall the bridge.
    await setImmediate();
    if (Date.now() > deadline) return { status: 200, body: { sessions, truncated: true } };
    const hit = searchSession(meta.id, ctx.store.loadTranscript(meta.id), match, SESSION_SEARCH_PER_SESSION);
    if (!hit) continue;
    sessions.push(hit);
    if (sessions.length >= SESSION_SEARCH_MAX_SESSIONS) {
      return { status: 200, body: { sessions, truncated: true } satisfies SessionSearchResponse };
    }
  }
  return { status: 200, body: { sessions } satisfies SessionSearchResponse };
}

/**
 * A stored attachment as base64, guarding against path traversal. Only the
 * requesting user's own attachments root is searched, so another user's
 * sessionId simply 404s.
 *
 * Base64 rather than raw bytes because this now travels as JSON on the socket;
 * the client turns it back into a blob URL. Symmetric with the upload path,
 * which is already base64.
 */
function readAttachment(ctx: UserContext, params: FileRequestParams, access: SocketAccess): FileRouteResult {
  const attachmentsRoot = ctx.store.attachmentsRoot;
  const abs = path.resolve(attachmentsRoot, params.rel ?? '');
  if (abs !== attachmentsRoot && !abs.startsWith(attachmentsRoot + path.sep)) {
    return { status: 403 };
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return { status: 404 };
  }
  if (buf.byteLength > MAX_FILE_BYTES) return { status: 413 };
  return {
    status: 200,
    body: {
      data: buf.toString('base64'),
      mediaType: MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
    },
  };
}

/**
 * The bridge's storage-sync diagnostics: why the "cloud sync unavailable" pill
 * appeared, and whether it is still up. Rides this already-authenticated
 * plumbing rather than a socket message of its own — it is a read of a file
 * under the user's store root, like every other route here.
 */
function readSyncLog(ctx: UserContext, _params: FileRequestParams, _access: SocketAccess): FileRouteResult {
  return { status: 200, body: { entries: ctx.store.readSyncLog(200), status: ctx.sync.status } };
}

/**
 * Is this session inside the connection's grant? `readFiles` alone is not enough
 * for the two session-diff kinds: they return contents from the host's working
 * tree, so a session-scope guest must not read a sibling session's changes. Same
 * in-handler clamping `syncLog`'s owner check uses.
 */
function sessionInReach(sessionId: string, access: SocketAccess): boolean {
  if (access.scope === 'owner' || access.scope === 'machine') return true;
  return !!access.sessionIds?.includes(sessionId);
}

/** One session's changes, file by file, per commit unit. */
async function readSessionDiff(
  ctx: UserContext,
  params: FileRequestParams,
  access: SocketAccess,
): Promise<FileRouteResult> {
  const sessionId = params.sessionId ?? '';
  if (!sessionId || !sessionInReach(sessionId, access)) return { status: 403 };
  const body = await ctx.sessions.changeSummary(sessionId);
  return body ? { status: 200, body } : { status: 404 };
}

/**
 * The two sides of one changed file: its contents at the session's baseline, and
 * on disk now. Empty `before` means the session created it; empty `after` means
 * it deleted it.
 */
async function readSessionDiffFile(
  ctx: UserContext,
  params: FileRequestParams,
  access: SocketAccess,
): Promise<FileRouteResult> {
  const sessionId = params.sessionId ?? '';
  if (!sessionId || !sessionInReach(sessionId, access)) return { status: 403 };
  const repo = soleRoot(ctx, params, access);
  const rel = params.rel ?? '';
  if (!repo || !rel) return { status: 403 };
  // Containment twice over: the repo root is inside the grant's workspace, and
  // the file is inside the repo.
  const abs = path.resolve(repo, rel);
  if (abs !== repo && !abs.startsWith(repo + path.sep)) return { status: 403 };
  // Doubles as "is this repo one of the session's commit units?" — null if not.
  const ref = await ctx.sessions.baselineRefFor(sessionId, repo);
  if (!ref) return { status: 404 };

  const before = await showFile(repo, ref, rel);
  let after = '';
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return { status: 404 };
    if (stat.size > MAX_FILE_BYTES) return { status: 413 };
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) return { status: 415 };
    after = buf.toString('utf8');
  } catch {
    // Absent on disk is the normal shape of a deleted file, not an error.
  }
  if (before.length > MAX_FILE_BYTES) return { status: 413 };
  return { status: 200, body: { before, after } };
}

const ROUTES: Record<
  FileRequestKind,
  (
    ctx: UserContext,
    p: FileRequestParams,
    access: SocketAccess,
  ) => FileRouteResult | Promise<FileRouteResult>
> = {
  file: readFile,
  tree: readTree,
  docs: readDocs,
  find: findFiles,
  attachment: readAttachment,
  syncLog: readSyncLog,
  sessionDiff: readSessionDiff,
  sessionDiffFile: readSessionDiffFile,
  grep: grepFiles,
  sessionSearch: searchSessionsRoute,
};

/** Dispatch one request. An unknown kind is a client bug, not a path to serve. */
export async function handleFileRequest(
  ctx: UserContext,
  kind: FileRequestKind,
  params: FileRequestParams,
  /** The connection's grant. Every path is clamped to what it may reach. */
  access: SocketAccess,
): Promise<FileRouteResult> {
  const route = ROUTES[kind];
  if (!route) return { status: 400 };
  // A guest has no store of their own on this machine, so the sync log — which
  // is the host's storage-link history — is owner-only.
  if (kind === 'syncLog' && access.scope !== 'owner') return { status: 403 };
  try {
    return await route(ctx, params, access);
  } catch (err) {
    console.error('[file]', kind, err);
    return { status: 500 };
  }
}
