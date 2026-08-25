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
import fs from 'node:fs';
import path from 'node:path';
import type { FileRequestKind, FileRequestParams, SocketAccess } from '@lines/shared';
import { collectDocs } from './docsBundle.ts';
import { searchFilesAcross } from './fileSearch.ts';
import { showFile } from './git.ts';
import type { UserContext } from './userContext.ts';
import { resolveWorkspacePath } from './workspacePaths.ts';

export interface FileRouteResult {
  status: number;
  body?: unknown;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const FIND_MAX_LIMIT = 25;

/** Directory entries hidden from the file tree. */
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
  const entries = dirents
    .filter((d) => !d.name.startsWith('.') && !TREE_IGNORE.has(d.name))
    .filter((d) => d.isDirectory() || d.isFile())
    .map((d) => ({ name: d.name, type: d.isDirectory() ? ('dir' as const) : ('file' as const) }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { status: 200, body: { entries } };
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
    body: { files: searchFilesAcross(roots as string[], params.q ?? '', limit) },
  };
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
