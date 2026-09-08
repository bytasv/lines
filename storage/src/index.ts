/**
 * Storage-only server (:8790): durable per-user workflows/settings/session
 * metadata in Supabase Postgres via Prisma. No CLI, no filesystem, no agent
 * execution. Every request authenticates a Clerk token; all rows are scoped
 * by the verified userId — the bridge forwards user tokens, never re-signs.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
// Aliased: the global `Response` in scope here is undici's, not Express's.
import type { ErrorRequestHandler, Request, Response as ExResponse } from 'express';
import {
  RECIPE_IMAGE_MAX_BYTES,
  RECIPE_IMAGE_TYPES,
  SHARE_PRESETS,
  capsForPreset,
  parseShareCaps,
  presetOfCaps,
  type SharePreset,
} from '@lines/shared';
import { presenceOf } from './presence.ts';
import {
  authorizeDevice,
  capsJson,
  forgetShareContact,
  normalizeEmail,
  profileOf,
  recordShareContact,
  revokeGrantsForDevice,
} from './shares.ts';
import { putRecipeImage, r2Configured, r2PublicBaseWarning } from './r2.ts';
import { listSessions, putSession, putSessions, softDeleteSession, toWire } from './sessionRows.ts';

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  console.warn('[storage] DATABASE_URL not set — storage server not starting');
  process.exit(0);
}
if (!process.env.CLERK_SECRET_KEY) {
  console.warn('[storage] CLERK_SECRET_KEY not set — storage server not starting');
  process.exit(0);
}

const [{ default: express }, { clerkClient, clerkMiddleware, getAuth }, { prisma }] =
  await Promise.all([import('express'), import('@clerk/express'), import('./db.ts')]);

// Fail fast with one actionable line instead of a raw code-frame trace. Catches
// a missing Prisma client (postinstall skipped by `ignore-scripts`) and an
// unreachable Supabase at boot; a mid-run outage surfaces via 500s to the bridge.
try {
  await prisma.$connect();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(
    '[storage] cannot reach database — run `npm run generate -w storage` and check DATABASE_URL:',
    msg,
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 8790);

const app = express();
// Express's automatic ETag hashes the response body, so the rows have already
// been read out of Postgres by the time it can answer 304 — no egress saved,
// and the sync client would have to treat a 304 as valid on every endpoint.
// The two shared routes below set an ETag explicitly, from an aggregate that
// runs *before* the real query.
app.set('etag', false);
// A global `json({ limit: '2mb' })` rejects a 2 MB screenshot before any
// route-level parser could run, so the limit is picked per path here instead.
const jsonSmall = express.json({ limit: '2mb' });
const jsonUpload = express.json({ limit: '8mb' });
app.use((req, res, next) => (req.path === '/recipes/images' ? jsonUpload : jsonSmall)(req, res, next));

// Recipe images are optional — unlike DATABASE_URL this is a warning, not an
// exit, and the upload route answers 503 until it is configured.
if (!r2Configured()) {
  console.warn('[storage] R2 not configured — recipe image uploads disabled');
} else {
  const warning = r2PublicBaseWarning();
  if (warning) console.warn(`[storage] ${warning}`);
}

// Egress meter. Off by default; STORAGE_LOG_BYTES=1 logs one line per request so
// a change in query shape shows up as a change in bytes rather than a guess.
if (process.env.STORAGE_LOG_BYTES) {
  app.use((req, res, next) => {
    res.on('finish', () => {
      console.log('[storage:bytes]', req.method, req.path, res.statusCode, res.getHeader('content-length') ?? 0);
    });
    next();
  });
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

/**
 * CORS. Needed only once the browser talks to this server directly, which it
 * does in the hosted split (web app on one origin, storage on another). Empty in
 * a local setup, where the bridge is the only caller and same-origin rules do
 * not apply to it.
 *
 * An explicit origin list, not `*`: these responses carry another user's data if
 * the Clerk token is wrong, and a wildcard would let any page on the internet
 * make authenticated calls on a signed-in user's behalf.
 */
const WEB_ORIGINS = (process.env.WEB_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && WEB_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    // The allowed origin varies by request, so caches must key on it.
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  // Preflights carry no Authorization header, so they must answer before the
  // auth gate below or every cross-origin call fails as a 401 on the OPTIONS.
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

/**
 * Routes that must answer without a Clerk user, and why:
 *
 *   /v1/devices/register — the machine has no user yet; that is the whole point
 *     of pairing. The row it creates is inert until someone claims the code.
 *   /v1/devices/verify — called by the relay, machine to machine, with no user
 *     token to present. Guarded by a shared secret instead (below), and kept off
 *     the public router: it trades a device secret for the owning user id, so it
 *     has no business being reachable from the internet.
 *   /v1/devices/unpair — called by the machine itself, which holds no user token
 *     and no relay secret. It proves possession of its own device secret instead,
 *     exactly as /verify does. Unlike /verify it must stay internet-reachable:
 *     the machine dials storage directly, the same way it does to register. This
 *     is the path that makes a lockout unrecoverable-proof — without it a machine
 *     whose owner cannot reach the web app can never be re-paired.
 *   /v1/devices/presence — called by the relay, machine to machine, as /verify is.
 *     Only the relay knows which hubs have a bridge attached, and this is how that
 *     reaches storage without giving the relay a query surface of its own. Same
 *     shared-secret gate, same reasons to keep it off the public router.
 *   /v1/devices/authorize — the relay's grant oracle, called with the *browser's*
 *     verified user id (the relay checked the Clerk token itself). It answers
 *     whether that user may reach a machine they do not own, so like /verify it is
 *     shared-secret gated and internal-only.
 */
const UNAUTHENTICATED_PATHS = new Set([
  '/v1/devices/register',
  '/v1/devices/verify',
  '/v1/devices/unpair',
  '/v1/devices/presence',
  '/v1/devices/authorize',
]);

/**
 * Shared secret for relay→storage calls. Required in a deployment: without it
 * `/v1/devices/verify` would be an open oracle for testing device secrets, and
 * `/v1/devices/presence` would let anyone flip a machine's liveness dot.
 */
const RELAY_SHARED_SECRET = process.env.RELAY_SHARED_SECRET;
app.use(['/v1/devices/verify', '/v1/devices/presence', '/v1/devices/authorize'], (req, res, next) => {
  if (!RELAY_SHARED_SECRET) {
    // originalUrl, not path: inside a mounted middleware the mount prefix is stripped.
    console.warn(`[storage] RELAY_SHARED_SECRET not set — refusing ${req.originalUrl}`);
    res.status(503).json({ error: 'relay calls are not configured' });
    return;
  }
  const presented = req.header('x-relay-secret') ?? '';
  if (!timingSafeEqualUtf8(presented, RELAY_SHARED_SECRET)) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  next();
});

app.use(
  clerkMiddleware({
    secretKey: process.env.CLERK_SECRET_KEY,
    // Reuse the web app's key — same Clerk instance, one .env entry.
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? process.env.VITE_CLERK_PUBLISHABLE_KEY,
  }),
);
// API-style 401 (requireAuth() redirects browsers to sign-in — wrong for a JSON API).
app.use((req, res, next) => {
  if (UNAUTHENTICATED_PATHS.has(req.path)) {
    next();
    return;
  }
  if (!getAuth(req).userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  next();
});

/** Verified Clerk user id for this request. */
function userIdOf(req: Request): string {
  const { userId } = getAuth(req);
  if (!userId) throw new Error('unauthenticated'); // requireAuth guarantees this never happens
  return userId;
}

/** Client-stamped LWW timestamp from a synced payload, falling back to now. */
function updatedAtOf(data: unknown): Date {
  const ms = (data as { updatedAt?: number } | null)?.updatedAt;
  return typeof ms === 'number' ? new Date(ms) : new Date();
}

/**
 * Client-stamped creation time, falling back to the payload's `updatedAt` rather
 * than to now: an old bridge re-pushing every row it holds (see
 * `server/src/userContext.ts`) sends no `createdAt`, and it has to land on the
 * same value the migration's backfill derived. Merged with `LEAST` on conflict,
 * so a late guess can never move a known creation time forward.
 */
function createdAtOf(data: unknown): Date {
  const ms = (data as { createdAt?: number } | null)?.createdAt;
  return typeof ms === 'number' ? new Date(ms) : updatedAtOf(data);
}

/**
 * Rows are stamped with a *client-supplied* `updatedAt` (see `updatedAtOf`), so
 * the column is not monotonic with commit order: a row can be committed after a
 * pull yet carry an earlier timestamp. The cursor therefore rewinds by this much
 * before filtering. The overlap re-sends a few recent rows, which is free — every
 * consumer of a pull is last-write-wins and idempotent — and in exchange no write
 * can ever fall through the gap.
 */
const SINCE_REWIND_MS = 5 * 60_000;

/** `?since=<iso>` delta cursor, rewound for safety. undefined = full pull. */
function sinceOf(req: Request): Date | undefined {
  const raw = req.query.since;
  if (typeof raw !== 'string') return undefined;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? undefined : new Date(ms - SINCE_REWIND_MS);
}

/**
 * Hand back the newest `updated_at` in this response as the next cursor. Taking
 * it from the rows rather than from a clock means no extra round trip and no
 * dependence on either side's wall clock. No rows -> no header -> the client
 * keeps the cursor it already had.
 */
function stampCursor(res: ExResponse, rows: { updatedAt: Date }[]): void {
  if (rows.length === 0) return;
  const newest = rows.reduce((max, r) => (r.updatedAt > max ? r.updatedAt : max), rows[0].updatedAt);
  res.setHeader('x-sync-cursor', newest.toISOString());
}

// --- workflows -------------------------------------------------------------

app.get('/workflows', async (req, res) => {
  const since = sinceOf(req);
  const rows = await prisma.workflow.findMany({
    where: { userId: userIdOf(req), ...(since ? { updatedAt: { gte: since } } : {}) },
    select: { data: true, updatedAt: true, createdAt: true },
  });
  stampCursor(res, rows);
  // The column is the authority on creation time, so it is injected over whatever
  // the blob carries — that is what makes it survive a push from a client that
  // does not know the field at all.
  res.json(rows.map((r) => ({ ...(r.data as object), createdAt: r.createdAt.getTime() })));
});

/**
 * Cheap change-detector for a cross-user scan. `count` catches publishes and
 * unpublishes, `max(updated_at)` catches edits; both come from an index-only
 * aggregate that reads no `data` blobs. Returns true when it has already
 * answered 304, in which case the caller must not run the real query.
 */
function servedFromEtag(req: Request, res: ExResponse, tag: { count: bigint; max: Date | null }): boolean {
  const etag = `W/"${tag.count}-${tag.max?.getTime() ?? 0}"`;
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return true;
  }
  return false;
}

/** Every other user's published workflows — the cross-user read path. */
app.get('/workflows/shared', async (req, res) => {
  const userId = userIdOf(req);
  const [tag] = await prisma.$queryRaw<{ count: bigint; max: Date | null }[]>`
    SELECT count(*) AS count, max(updated_at) AS max FROM workflows
    WHERE published AND user_id <> ${userId}`;
  if (servedFromEtag(req, res, tag)) return;
  const rows = await prisma.workflow.findMany({
    where: { published: true, NOT: { userId } },
    select: { data: true, userId: true },
  });
  // The row's `user_id` is the authority on ownership, so it overrides whatever
  // the blob claims: a stale (or forged) `ownerId` inside `data` is exactly what
  // the bridge's own-beats-shared filter must not be fooled by.
  res.json(rows.map((r) => ({ ...(r.data as object), ownerId: r.userId })));
});

/**
 * One multi-row statement, not a loop of upserts: `$executeRaw` returns a row
 * count instead of the rows, so a push costs no egress at all — a per-item
 * `prisma.upsert` echoes every `data` blob straight back over the wire.
 */
app.put('/workflows', async (req, res) => {
  const userId = userIdOf(req);
  const list = Array.isArray(req.body) ? (req.body as { id?: string; published?: boolean }[]) : [];
  const valid = list.filter((wf) => wf?.id);
  if (valid.length === 0) {
    res.json({ ok: true, count: 0 });
    return;
  }
  // The two adjacent timestamptz arrays are positional: array order, the `AS u(…)`
  // alias order and the SELECT list must all agree. Swapping them is type-valid
  // and Postgres would accept it silently, so they are edited as one hunk.
  await prisma.$executeRaw`
    INSERT INTO workflows (user_id, id, data, published, updated_at, created_at)
    SELECT ${userId}, u.id, u.data::jsonb, u.published, u.updated_at, u.created_at
    FROM UNNEST(
      ${valid.map((wf) => wf.id!)}::text[],
      ${valid.map((wf) => JSON.stringify(wf))}::text[],
      ${valid.map((wf) => wf.published === true)}::bool[],
      ${valid.map((wf) => updatedAtOf(wf).toISOString())}::timestamptz[],
      ${valid.map((wf) => createdAtOf(wf).toISOString())}::timestamptz[]
    ) AS u(id, data, published, updated_at, created_at)
    ON CONFLICT (user_id, id) DO UPDATE
      SET data = EXCLUDED.data, published = EXCLUDED.published, updated_at = EXCLUDED.updated_at,
          -- Earliest wins: idempotent across peers, and a push with no creation
          -- time of its own (an old bridge) can never move it forward.
          created_at = LEAST(workflows.created_at, EXCLUDED.created_at)`;
  res.json({ ok: true, count: valid.length });
});

app.delete('/workflows/:id', async (req, res) => {
  // deleteMany, not delete: returns a count instead of the deleted row's blob,
  // and a missing row is a no-op rather than a throw.
  await prisma.workflow.deleteMany({ where: { userId: userIdOf(req), id: req.params.id } });
  res.json({ ok: true });
});

// --- steps (versioned, shareable) ------------------------------------------

/** Ceiling on one /steps/resolve batch, so a malformed client can't ask for everything. */
const RESOLVE_MAX_REFS = 500;

/**
 * Head selection happens in Postgres, not JS. Version rows are immutable and
 * append-only, so a `findMany` + reduce-in-JS transferred the entire edit
 * history of every step just to keep the newest row of each — the discarded
 * rows were pure egress. `DISTINCT ON` returns only the heads, and is exact by
 * construction (no denormalised head flag that a republish could desync).
 */
app.get('/steps', async (req, res) => {
  // All of the caller's own steps (published or not) — their private library.
  //
  // `since` filters before the head pick, which is safe here because version
  // rows are append-only: a step that gained versions has its newest one inside
  // the window, and a step that gained none has nothing to adopt. A head picked
  // from a partial window can only ever be older than the local copy, and the
  // bridge's LWW-on-version adopt ignores those.
  const since = sinceOf(req);
  const userId = userIdOf(req);
  //
  // `created_at` comes from a grouped subquery over the *whole* lineage rather
  // than from the head row or a window function: a step's creation is when its id
  // was first written, and with `?since=` a window would only ever see the rows
  // inside the delta and report a birth that is too recent.
  const rows = since
    ? await prisma.$queryRaw<{ data: unknown; updatedAt: Date; createdAt: Date }[]>`
        SELECT DISTINCT ON (sv.user_id, sv.id) sv.data, sv.updated_at AS "updatedAt",
               m.created_at AS "createdAt"
        FROM step_versions sv
        JOIN (
          SELECT user_id, id, min(created_at) AS created_at FROM step_versions
          WHERE user_id = ${userId} GROUP BY user_id, id
        ) m ON m.user_id = sv.user_id AND m.id = sv.id
        WHERE sv.user_id = ${userId} AND sv.updated_at >= ${since}
        ORDER BY sv.user_id, sv.id, sv.version DESC`
    : await prisma.$queryRaw<{ data: unknown; updatedAt: Date; createdAt: Date }[]>`
        SELECT DISTINCT ON (sv.user_id, sv.id) sv.data, sv.updated_at AS "updatedAt",
               m.created_at AS "createdAt"
        FROM step_versions sv
        JOIN (
          SELECT user_id, id, min(created_at) AS created_at FROM step_versions
          WHERE user_id = ${userId} GROUP BY user_id, id
        ) m ON m.user_id = sv.user_id AND m.id = sv.id
        WHERE sv.user_id = ${userId}
        ORDER BY sv.user_id, sv.id, sv.version DESC`;
  stampCursor(res, rows);
  res.json(rows.map((r) => ({ ...(r.data as object), createdAt: r.createdAt.getTime() })));
});

/** Every other user's published steps, head version only — the library. */
app.get('/steps/shared', async (req, res) => {
  const userId = userIdOf(req);
  const [tag] = await prisma.$queryRaw<{ count: bigint; max: Date | null }[]>`
    SELECT count(*) AS count, max(updated_at) AS max FROM step_versions
    WHERE published AND user_id <> ${userId}`;
  if (servedFromEtag(req, res, tag)) return;
  const rows = await prisma.$queryRaw<{ data: unknown; userId: string }[]>`
    SELECT DISTINCT ON (user_id, id) data, user_id AS "userId" FROM step_versions
    WHERE published AND user_id <> ${userId}
    ORDER BY user_id, id, version DESC`;
  // `ownerId` from the row's `user_id`, as /workflows/shared: the blob is not
  // trusted to say who owns it.
  res.json(rows.map((r) => ({ ...(r.data as object), ownerId: r.userId })));
});

app.put('/steps', async (req, res) => {
  const userId = userIdOf(req);
  const list = Array.isArray(req.body) ? (req.body as { id?: string; version?: number; published?: boolean }[]) : [];
  // The bridge pushes the whole own version history on every step change, so the
  // loop-of-upserts this replaces echoed every historical blob back per push.
  const valid = list.filter((s) => s?.id && typeof s.version === 'number');
  if (valid.length === 0) {
    res.json({ ok: true, count: 0 });
    return;
  }
  // `created_at` is fed from `updatedAtOf`, NOT `createdAtOf`: the blob's
  // `createdAt` is the *lineage's* birth, and the bridge re-pushes the whole
  // history on every step change — feeding it in would collapse every version
  // row's `created_at` to the same instant and destroy the evidence the lineage
  // minimum is derived from. The two adjacent timestamptz arrays are positional;
  // array, alias and SELECT order must all agree (see PUT /workflows).
  await prisma.$executeRaw`
    INSERT INTO step_versions (user_id, id, version, data, published, updated_at, created_at)
    SELECT ${userId}, u.id, u.version, u.data::jsonb, u.published, u.updated_at, u.created_at
    FROM UNNEST(
      ${valid.map((s) => s.id!)}::text[],
      ${valid.map((s) => s.version!)}::int[],
      ${valid.map((s) => JSON.stringify(s))}::text[],
      ${valid.map((s) => s.published !== false)}::bool[],
      ${valid.map((s) => updatedAtOf(s).toISOString())}::timestamptz[],
      ${valid.map((s) => updatedAtOf(s).toISOString())}::timestamptz[]
    ) AS u(id, version, data, published, updated_at, created_at)
    ON CONFLICT (user_id, id, version) DO UPDATE
      SET data = EXCLUDED.data, published = EXCLUDED.published, updated_at = EXCLUDED.updated_at,
          created_at = LEAST(step_versions.created_at, EXCLUDED.created_at)`;
  res.json({ ok: true, count: valid.length });
});

/** Resolve specific immutable versions a workflow pins (any author). */
app.post('/steps/resolve', async (req, res) => {
  userIdOf(req); // auth only
  const refs = Array.isArray(req.body) ? (req.body as { ownerId?: string; id?: string; version?: number }[]) : [];
  const valid = refs.filter((r) => r?.ownerId && r?.id && typeof r.version === 'number');
  if (valid.length === 0) {
    res.json([]);
    return;
  }
  const rows = await prisma.stepVersion.findMany({
    where: { OR: valid.slice(0, RESOLVE_MAX_REFS).map((r) => ({ userId: r.ownerId!, id: r.id!, version: r.version! })) },
    select: { data: true },
  });
  res.json(rows.map((r) => r.data));
});

/** Full version history for one step, newest first. Own steps: all versions; foreign: published only. */
app.get('/steps/:ownerId/:id/versions', async (req, res) => {
  const requester = userIdOf(req);
  const { ownerId, id } = req.params;
  const rows = await prisma.stepVersion.findMany({
    where: { userId: ownerId, id, ...(requester === ownerId ? {} : { published: true }) },
    orderBy: { version: 'desc' },
    take: 200,
    select: { data: true },
  });
  res.json(rows.map((r) => r.data));
});

/** Drop a step from the library — flip every version's published flag off; rows stay so pins resolve. */
app.delete('/steps/:id', async (req, res) => {
  await prisma.stepVersion
    .updateMany({ where: { userId: userIdOf(req), id: req.params.id }, data: { published: false } })
    .catch(() => undefined);
  res.json({ ok: true });
});

// --- recipes (versioned, shareable) ----------------------------------------

/** All of the caller's own recipe heads (published or not) — their private library. */
app.get('/recipes', async (req, res) => {
  // `since` filters before the head pick for the same reason as /steps: version
  // rows are append-only, so a head picked from a partial window can only be
  // older than the local copy, and the bridge's LWW-on-version adopt ignores it.
  const since = sinceOf(req);
  const userId = userIdOf(req);
  const rows = since
    ? await prisma.$queryRaw<{ data: unknown; updatedAt: Date }[]>`
        SELECT DISTINCT ON (user_id, id) data, updated_at AS "updatedAt" FROM recipe_versions
        WHERE user_id = ${userId} AND updated_at >= ${since}
        ORDER BY user_id, id, version DESC`
    : await prisma.$queryRaw<{ data: unknown; updatedAt: Date }[]>`
        SELECT DISTINCT ON (user_id, id) data, updated_at AS "updatedAt" FROM recipe_versions
        WHERE user_id = ${userId}
        ORDER BY user_id, id, version DESC`;
  stampCursor(res, rows);
  res.json(rows.map((r) => r.data));
});

/**
 * Every other user's published recipes, head version only — the browsable
 * corpus. ETag'd on content alone (`count(*)`/`max(updated_at)` of version
 * rows), which is why run counts deliberately do not ride this route: a 304
 * here must not be able to freeze them. They come from /recipes/stats instead.
 */
app.get('/recipes/shared', async (req, res) => {
  const userId = userIdOf(req);
  const [tag] = await prisma.$queryRaw<{ count: bigint; max: Date | null }[]>`
    SELECT count(*) AS count, max(updated_at) AS max FROM recipe_versions
    WHERE published AND user_id <> ${userId}`;
  if (servedFromEtag(req, res, tag)) return;
  const rows = await prisma.$queryRaw<{ data: unknown }[]>`
    SELECT DISTINCT ON (user_id, id) data FROM recipe_versions
    WHERE published AND user_id <> ${userId}
    ORDER BY user_id, id, version DESC`;
  res.json(rows.map((r) => r.data));
});

/**
 * Run counts for every recipe the caller can see (own, plus anyone's published).
 * Its own ETag comes from `sum(run_count)` rather than `count(*)`, so re-running
 * an already-counted recipe still busts it.
 */
app.get('/recipes/stats', async (req, res) => {
  const userId = userIdOf(req);
  const [tag] = await prisma.$queryRaw<{ count: bigint; max: Date | null }[]>`
    SELECT coalesce(sum(run_count), 0)::bigint AS count, max(last_run_at) AS max FROM recipe_stats`;
  if (servedFromEtag(req, res, tag)) return;
  const rows = await prisma.$queryRaw<{ ownerId: string; id: string; runCount: number }[]>`
    SELECT s.user_id AS "ownerId", s.id, s.run_count AS "runCount" FROM recipe_stats s
    WHERE s.user_id = ${userId}
       OR EXISTS (SELECT 1 FROM recipe_versions v
                  WHERE v.user_id = s.user_id AND v.id = s.id AND v.published)`;
  res.json(rows);
});

/**
 * Count one run per recipe. Batched, because a bundle of six must not be six
 * round trips — a single run is just a batch of one, so there is one route.
 *
 * Authorization and the atomic increment are the same statement: the `EXISTS`
 * join means a fabricated key contributes no row rather than creating one, and
 * only the rows that passed come back, so the caller learns which keys were
 * rejected by their absence.
 */
app.post('/recipes/run', async (req, res) => {
  const me = userIdOf(req);
  const list = Array.isArray(req.body) ? (req.body as { ownerId?: string; id?: string }[]) : [];
  // `ON CONFLICT DO UPDATE` cannot affect the same row twice in one statement,
  // and a bundle legitimately may list the same recipe twice — dedupe first.
  const seen = new Set<string>();
  const pairs: { ownerId: string; id: string }[] = [];
  for (const r of list) {
    if (!r?.ownerId || !r?.id) continue;
    const key = `${r.ownerId}/${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ ownerId: r.ownerId, id: r.id });
  }
  if (pairs.length === 0) {
    res.status(404).json({ error: 'no runnable recipes' });
    return;
  }
  const rows = await prisma.$queryRaw<{ ownerId: string; id: string; runCount: number }[]>`
    INSERT INTO recipe_stats (user_id, id, run_count, last_run_at)
    SELECT u.owner_id, u.id, 1, now()
    FROM UNNEST(${pairs.map((p) => p.ownerId)}::text[], ${pairs.map((p) => p.id)}::text[]) AS u(owner_id, id)
    WHERE EXISTS (SELECT 1 FROM recipe_versions v
                  WHERE v.user_id = u.owner_id AND v.id = u.id
                    AND (v.published OR v.user_id = ${me}))
    ON CONFLICT (user_id, id) DO UPDATE
      SET run_count = recipe_stats.run_count + 1, last_run_at = now()
    RETURNING user_id AS "ownerId", id, run_count AS "runCount"`;
  if (rows.length === 0) {
    res.status(404).json({ error: 'no runnable recipes' });
    return;
  }
  res.json(rows);
});

/** Upload one recipe screenshot to R2; answers its public URL. */
app.post('/recipes/images', async (req, res) => {
  const userId = userIdOf(req);
  if (!r2Configured()) {
    // 503, not 500: the bridge marks this a soft error so an install without R2
    // shows an inline uploader message instead of a global sync-outage banner.
    res.status(503).json({ error: 'recipe images not configured' });
    return;
  }
  const body = req.body as { mediaType?: unknown; data?: unknown } | null;
  const mediaType = typeof body?.mediaType === 'string' ? body.mediaType : '';
  if (!RECIPE_IMAGE_TYPES.includes(mediaType as (typeof RECIPE_IMAGE_TYPES)[number])) {
    res.status(400).json({ error: 'unsupported image type' });
    return;
  }
  if (typeof body?.data !== 'string' || !body.data) {
    res.status(400).json({ error: 'body must hold base64 data' });
    return;
  }
  const buf = Buffer.from(body.data, 'base64');
  // Re-validated here rather than trusting the browser's downscale.
  if (buf.byteLength === 0 || buf.byteLength > RECIPE_IMAGE_MAX_BYTES) {
    res.status(400).json({ error: 'image too large' });
    return;
  }
  res.json({ url: await putRecipeImage(userId, mediaType, buf) });
});

/**
 * One multi-row upsert, as PUT /steps. Unlike steps, an absent `published` means
 * **private**: recipes are published deliberately, so a blob from a client that
 * predates the flag must not become world-visible.
 */
app.put('/recipes', async (req, res) => {
  const userId = userIdOf(req);
  const list = Array.isArray(req.body) ? (req.body as { id?: string; version?: number; published?: boolean }[]) : [];
  const valid = list.filter((r) => r?.id && typeof r.version === 'number');
  if (valid.length === 0) {
    res.json({ ok: true, count: 0 });
    return;
  }
  await prisma.$executeRaw`
    INSERT INTO recipe_versions (user_id, id, version, data, published, updated_at)
    SELECT ${userId}, u.id, u.version, u.data::jsonb, u.published, u.updated_at
    FROM UNNEST(
      ${valid.map((r) => r.id!)}::text[],
      ${valid.map((r) => r.version!)}::int[],
      ${valid.map((r) => JSON.stringify(r))}::text[],
      ${valid.map((r) => r.published === true)}::bool[],
      ${valid.map((r) => updatedAtOf(r).toISOString())}::timestamptz[]
    ) AS u(id, version, data, published, updated_at)
    ON CONFLICT (user_id, id, version) DO UPDATE
      SET data = EXCLUDED.data, published = EXCLUDED.published, updated_at = EXCLUDED.updated_at`;
  res.json({ ok: true, count: valid.length });
});

/** Full version history for one recipe, newest first. Own: all; foreign: published only. */
app.get('/recipes/:ownerId/:id/versions', async (req, res) => {
  const requester = userIdOf(req);
  const { ownerId, id } = req.params;
  const rows = await prisma.recipeVersion.findMany({
    where: { userId: ownerId, id, ...(requester === ownerId ? {} : { published: true }) },
    orderBy: { version: 'desc' },
    take: 200,
    select: { data: true },
  });
  res.json(rows.map((r) => r.data));
});

/** Unpublish a recipe — every version's flag flips off; rows stay, as with steps. */
app.delete('/recipes/:id', async (req, res) => {
  await prisma.recipeVersion
    .updateMany({ where: { userId: userIdOf(req), id: req.params.id }, data: { published: false } })
    .catch(() => undefined);
  res.json({ ok: true });
});

// --- sessions (metadata only) ----------------------------------------------
//
// The row rules — LWW upsert, soft delete, resurrect guard — live in
// sessionRows.ts so they are testable without a Clerk token.

app.get('/sessions', async (req, res) => {
  // The heaviest pull in the system — session metadata accumulates forever and
  // the UI only ever shows the recent end of it. Bounded even on a full pull.
  const rows = await listSessions(prisma, userIdOf(req), sinceOf(req));
  stampCursor(res, rows);
  res.json(toWire(rows));
});

app.put('/sessions', async (req, res) => {
  const list = Array.isArray(req.body) ? (req.body as { id?: string }[]) : [];
  const count = await putSessions(prisma, userIdOf(req), list);
  res.json({ ok: true, count });
});

app.put('/sessions/:id', async (req, res) => {
  const meta = req.body as { id?: string };
  if (!meta?.id || meta.id !== req.params.id) {
    res.status(400).json({ error: 'body id must match path id' });
    return;
  }
  const { deleted } = await putSession(prisma, userIdOf(req), meta as { id: string });
  res.json({ ok: true, ...(deleted ? { deleted } : {}) });
});

app.delete('/sessions/:id', async (req, res) => {
  await softDeleteSession(prisma, userIdOf(req), req.params.id);
  res.json({ ok: true });
});

// --- project keys ------------------------------------------------------------

app.get('/project-keys', async (req, res) => {
  const row = await prisma.projectKeys.findUnique({ where: { userId: userIdOf(req) } });
  res.json(row?.data ?? {});
});

/**
 * Union, not replace. Each machine only knows the checkouts it can see, so a
 * plain overwrite would let the last install to sync drop every other one's
 * paths. Entries are effectively immutable, so first-write-wins is safe.
 *
 * The union is done in SQL — `EXCLUDED.data || project_keys.data` keeps the
 * stored value on key collision, which is exactly first-write-wins. Doing it
 * here rather than in JS drops a full-map read *and* a full-map echo per push.
 */
app.put('/project-keys', async (req, res) => {
  const userId = userIdOf(req);
  const incoming = req.body as Record<string, unknown> | null;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    res.status(400).json({ error: 'body must be an object' });
    return;
  }
  const clean: Record<string, string> = {};
  for (const [cwd, key] of Object.entries(incoming)) {
    if (typeof key === 'string' && key) clean[cwd] = key;
  }
  await prisma.$executeRaw`
    INSERT INTO project_keys (user_id, data, updated_at)
    VALUES (${userId}, ${JSON.stringify(clean)}::jsonb, now())
    ON CONFLICT (user_id) DO UPDATE
      SET data = EXCLUDED.data || project_keys.data, updated_at = now()`;
  res.json({ ok: true });
});

// --- settings ----------------------------------------------------------------

app.get('/settings', async (req, res) => {
  const row = await prisma.userSettings.findUnique({ where: { userId: userIdOf(req) } });
  res.json(row?.data ?? null);
});

app.put('/settings', async (req, res) => {
  const userId = userIdOf(req);
  await prisma.userSettings.upsert({
    where: { userId },
    create: { userId, data: req.body as object, updatedAt: updatedAtOf(req.body) },
    update: { data: req.body as object, updatedAt: updatedAtOf(req.body) },
    select: { userId: true },
  });
  res.json({ ok: true });
});

// --- auto-mode guard allowlist -----------------------------------------------

/** Hard cap on a stored list. Authoritative validation is the bridge's (normalizeAllowEntry). */
const GUARD_MAX_ENTRIES = 500;

app.get('/guard-allowlist', async (req, res) => {
  const row = await prisma.guardAllowlist.findUnique({ where: { userId: userIdOf(req) } });
  res.json(row?.data ?? null);
});

app.put('/guard-allowlist', async (req, res) => {
  const userId = userIdOf(req);
  const body = req.body as { entries?: unknown; updatedAt?: unknown } | null;
  if (!body || !Array.isArray(body.entries)) {
    res.status(400).json({ error: 'body must hold an entries array' });
    return;
  }
  // Light shape filter only, as PUT /memory does: the bridge re-validates every
  // entry on ingest before it can reach a UI, and that is where the real rules live.
  const entries: { tool: string; prefix?: string }[] = [];
  for (const raw of body.entries.slice(0, GUARD_MAX_ENTRIES)) {
    const e = raw as { tool?: unknown; prefix?: unknown } | null;
    if (!e || typeof e.tool !== 'string' || e.tool.length === 0) continue;
    if (e.prefix !== undefined && typeof e.prefix !== 'string') continue;
    entries.push(typeof e.prefix === 'string' ? { tool: e.tool, prefix: e.prefix } : { tool: e.tool });
  }
  const data = { entries, updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : Date.now() };
  await prisma.guardAllowlist.upsert({
    where: { userId },
    create: { userId, data, updatedAt: updatedAtOf(data) },
    update: { data, updatedAt: updatedAtOf(data) },
    select: { userId: true },
  });
  res.json({ ok: true });
});

// --- MCP connections ---------------------------------------------------------

/** Hard cap on a stored list. Authoritative validation is the bridge's (normalizeConnection). */
const MCP_MAX_CONNECTIONS = 50;

app.get('/mcp-connections', async (req, res) => {
  const row = await prisma.mcpConnections.findUnique({ where: { userId: userIdOf(req) } });
  res.json(row?.data ?? null);
});

app.put('/mcp-connections', async (req, res) => {
  const userId = userIdOf(req);
  const body = req.body as { connections?: unknown; updatedAt?: unknown } | null;
  if (!body || !Array.isArray(body.connections)) {
    res.status(400).json({ error: 'body must hold a connections array' });
    return;
  }
  // Light shape filter only, as PUT /guard-allowlist does: the bridge re-validates
  // every row on ingest before it can reach a UI, and that is where the real rules
  // live. `headers` is stripped rather than trusted — header values are
  // credentials and must never be stored here, whatever a client sends.
  // A type alias, not an interface: Prisma's Json input type needs an implicit
  // index signature, which only object type literals get.
  type StoredConnection = {
    id: string;
    name: string;
    transport: 'http' | 'sse' | 'stdio';
    enabled: boolean;
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    headerKeys?: string[];
    timeout?: number;
  };
  const connections: StoredConnection[] = [];
  for (const raw of body.connections.slice(0, MCP_MAX_CONNECTIONS)) {
    const c = raw as Record<string, unknown> | null;
    if (!c || typeof c.id !== 'string' || typeof c.name !== 'string' || !c.name) continue;
    if (c.transport !== 'http' && c.transport !== 'sse' && c.transport !== 'stdio') continue;
    const row: StoredConnection = {
      id: c.id,
      name: c.name,
      transport: c.transport,
      enabled: c.enabled !== false,
    };
    if (typeof c.url === 'string') row.url = c.url;
    if (typeof c.command === 'string') row.command = c.command;
    if (Array.isArray(c.args)) row.args = c.args.filter((a): a is string => typeof a === 'string');
    if (c.env && typeof c.env === 'object' && !Array.isArray(c.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.env as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v;
      }
      row.env = env;
    }
    if (Array.isArray(c.headerKeys)) {
      row.headerKeys = c.headerKeys.filter((k): k is string => typeof k === 'string');
    }
    if (typeof c.timeout === 'number') row.timeout = c.timeout;
    connections.push(row);
  }
  const data = { connections, updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : Date.now() };
  await prisma.mcpConnections.upsert({
    where: { userId },
    create: { userId, data, updatedAt: updatedAtOf(data) },
    update: { data, updatedAt: updatedAtOf(data) },
    select: { userId: true },
  });
  res.json({ ok: true });
});

// --- agent memory ------------------------------------------------------------

const MEMORY_KEY_RE = /^(user|project|slug)\//;
const MEMORY_ENTRY_MAX_BYTES = 256 * 1024;
const MEMORY_TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Row shape -> the MemoryFileMap entry shape the bridge already understands. */
function memoryEntry(r: { content: string; deleted: boolean; updatedAt: Date }) {
  const updatedAt = r.updatedAt.getTime();
  return r.deleted ? { content: '', updatedAt, deleted: true as const } : { content: r.content, updatedAt };
}

app.get('/memory', async (req, res) => {
  const since = sinceOf(req);
  const rows = await prisma.agentMemoryFile.findMany({
    where: { userId: userIdOf(req), ...(since ? { updatedAt: { gte: since } } : {}) },
    select: { key: true, content: true, deleted: true, updatedAt: true },
  });
  stampCursor(res, rows);
  const map: Record<string, ReturnType<typeof memoryEntry>> = {};
  for (const r of rows) map[r.key] = memoryEntry(r);
  res.json(map);
});

/**
 * Per-file last-write-wins merge (never a replace). Each machine only sees the
 * files on its own disk, so an overwrite would drop the others' entries.
 *
 * The LWW rule is the `WHERE` on the conflict clause — an incoming entry wins
 * iff it is strictly newer — so the merge costs one statement and reads nothing
 * back. The blob version had to fetch the whole map, merge it in JS, and write
 * it back in full for a single changed file.
 */
app.put('/memory', async (req, res) => {
  const userId = userIdOf(req);
  const incoming = req.body as Record<string, unknown> | null;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    res.status(400).json({ error: 'body must be an object' });
    return;
  }
  const rows: { key: string; content: string; deleted: boolean; updatedAt: string }[] = [];
  for (const [key, raw] of Object.entries(incoming)) {
    if (!MEMORY_KEY_RE.test(key)) continue;
    const entry = raw as { content?: unknown; updatedAt?: unknown; deleted?: unknown } | null;
    if (!entry || typeof entry.updatedAt !== 'number') continue;
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (Buffer.byteLength(content, 'utf8') > MEMORY_ENTRY_MAX_BYTES) continue;
    const deleted = entry.deleted === true;
    rows.push({
      key,
      content: deleted ? '' : content,
      deleted,
      updatedAt: new Date(entry.updatedAt).toISOString(),
    });
  }
  if (rows.length > 0) {
    await prisma.$executeRaw`
      INSERT INTO agent_memory_files (user_id, key, content, deleted, updated_at)
      SELECT ${userId}, u.key, u.content, u.deleted, u.updated_at
      FROM UNNEST(
        ${rows.map((r) => r.key)}::text[],
        ${rows.map((r) => r.content)}::text[],
        ${rows.map((r) => r.deleted)}::bool[],
        ${rows.map((r) => r.updatedAt)}::timestamptz[]
      ) AS u(key, content, deleted, updated_at)
      ON CONFLICT (user_id, key) DO UPDATE
        SET content = EXCLUDED.content, deleted = EXCLUDED.deleted, updated_at = EXCLUDED.updated_at
        WHERE agent_memory_files.updated_at < EXCLUDED.updated_at`;
  }
  // Drop long-dead tombstones so the table doesn't grow without bound.
  await prisma.agentMemoryFile.deleteMany({
    where: { userId, deleted: true, updatedAt: { lt: new Date(Date.now() - MEMORY_TOMBSTONE_MAX_AGE_MS) } },
  });
  res.json({ ok: true, count: rows.length });
});

/* ------------------------------------------------------------------ *
 * Devices — pairing a machine to an account
 *
 * The machine mints its own secret and only ever sends us a hash, so a database
 * compromise cannot yield anything that impersonates a device. Claiming is a
 * one-time code the signed-in user types on the web, which is what binds the
 * machine to an account: until then the row has no userId and the relay refuses
 * it.
 * ------------------------------------------------------------------ */

/** Codes are typed by a human, so keep them short and unambiguous. */
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const PAIRING_TTL_MS = 15 * 60_000;

function pairingCode(): string {
  const bytes = randomBytes(8);
  return [...bytes].map((b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join('');
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Start pairing. Unauthenticated on purpose: the machine has no user yet, and
 * the code is worthless until a signed-in user claims it.
 */
app.post('/v1/devices/register', async (req, res) => {
  const body = (req.body ?? {}) as { id?: string; secretHash?: string; name?: string; platform?: string; appProtocol?: number };
  if (!body.id || !body.secretHash || !body.name) {
    res.status(400).json({ error: 'id, secretHash and name are required' });
    return;
  }
  // The machine sends a hash; we never see the secret itself.
  if (!/^[0-9a-f]{64}$/.test(body.secretHash)) {
    res.status(400).json({ error: 'secretHash must be a sha256 hex digest' });
    return;
  }
  const code = pairingCode();
  const data = {
    name: body.name,
    platform: body.platform ?? null,
    secretHash: body.secretHash,
    appProtocol: body.appProtocol ?? null,
    pairingCode: code,
    pairingExpiresAt: new Date(Date.now() + PAIRING_TTL_MS),
  };
  // Re-registering the same machine re-issues a code rather than duplicating it,
  // but never silently re-binds one already claimed by a user.
  //
  // A REVOKED row is exempt: revocation leaves userId in place and only stamps
  // revokedAt, so treating any owned row as final meant a revoked machine could
  // never come back — register answered 409 while the relay refused it for being
  // revoked, and that device id was dead for good. Re-registering is safe because
  // the fresh code it returns is worthless until a signed-in user claims it.
  const existing = await prisma.device.findUnique({ where: { id: body.id } });
  if (existing?.userId && !existing.revokedAt) {
    res.status(409).json({ error: 'device already paired' });
    return;
  }
  await prisma.device.upsert({
    where: { id: body.id },
    create: { id: body.id, ...data },
    // Clear the previous owner and the revocation explicitly: leaving either in
    // place would hand the machine straight back to the account that revoked it,
    // or leave the relay refusing a row that now has a valid pairing code.
    update: { ...data, userId: null, revokedAt: null },
  });
  res.json({ pairingCode: code, expiresAt: data.pairingExpiresAt.toISOString() });
});

/** Claim a pending code. Authenticated: this is the step that binds machine to user. */
app.post('/v1/devices/claim', async (req, res) => {
  const userId = userIdOf(req);
  const code = String((req.body as { code?: string } | null)?.code ?? '').trim().toUpperCase();
  if (!code) {
    res.status(400).json({ error: 'code is required' });
    return;
  }
  const device = await prisma.device.findUnique({ where: { pairingCode: code } });
  if (!device || device.revokedAt || !device.pairingExpiresAt || device.pairingExpiresAt < new Date()) {
    // One message for absent, expired and revoked: a distinct "expired" reply
    // would confirm a guessed code had once been real.
    res.status(404).json({ error: 'unknown or expired code' });
    return;
  }
  const claimed = await prisma.device.update({
    where: { id: device.id },
    // Code cleared on use, so it cannot be replayed.
    data: { userId, pairingCode: null, pairingExpiresAt: null },
  });
  res.json({ id: claimed.id, name: claimed.name, platform: claimed.platform });
});

/**
 * This user's devices. Never returns secretHash.
 *
 * `online` is the relay's attach/detach report gated on `lastSeenAt` freshness
 * (presenceOf) — the browser gets a liveness claim it can act on, or `false`, and
 * never the raw flag. It is the only health signal available for a machine this
 * browser holds no socket to.
 */
app.get('/v1/devices', async (req, res) => {
  const userId = userIdOf(req);
  const select = {
    id: true,
    name: true,
    platform: true,
    appProtocol: true,
    createdAt: true,
    lastSeenAt: true,
    online: true,
  } as const;

  // Machines reachable through a live grant, alongside the ones this user owns.
  // Two queries rather than a join: the grant tables carry no foreign key, and
  // the id sets are small (shares are few by nature).
  const [owned, members, shares] = await Promise.all([
    prisma.device.findMany({ where: { userId, revokedAt: null }, select, orderBy: { createdAt: 'asc' } }),
    prisma.deviceMember.findMany({ where: { userId, revokedAt: null } }),
    prisma.sessionShare.findMany({ where: { userId, revokedAt: null } }),
  ]);

  // Session-scope grants collapse to one entry per machine carrying its sessions;
  // a machine grant is strictly wider and wins over any session share on the same
  // machine — the same precedence authorizeDevice applies.
  const sharedIds = new Set([...members.map((m) => m.deviceId), ...shares.map((s) => s.deviceId)]);

  const sharedRows = sharedIds.size
    ? await prisma.device.findMany({
        where: { id: { in: [...sharedIds] }, revokedAt: null },
        select: { ...select, userId: true },
      })
    : [];
  const ownerIds = [...new Set(sharedRows.map((row) => row.userId).filter((v): v is string => !!v))];
  const profiles = new Map(
    (await prisma.userProfile.findMany({ where: { userId: { in: ownerIds } } })).map((p) => [
      p.userId,
      { userId: p.userId, email: p.email, name: p.name, imageUrl: p.imageUrl },
    ]),
  );

  const shared = sharedRows
    .map(({ userId: ownerId, ...row }) => {
      // The device row, not the grant, says who owns a machine. A grant whose
      // denormalized ownerId no longer matches (the machine was unpaired and
      // re-claimed by someone else) is dead, and must not point at the new owner.
      const member = members.find((m) => m.deviceId === row.id && m.ownerId === ownerId);
      const sessionShares = shares.filter((s) => s.deviceId === row.id && s.ownerId === ownerId);
      if (!member && sessionShares.length === 0) return null;
      return {
        ...row,
        online: presenceOf(row),
        shared: true as const,
        scope: member ? ('machine' as const) : ('session' as const),
        caps: parseShareCaps(member ? member.caps : sessionShares[0].caps),
        ...(member ? {} : { sessionIds: sessionShares.map((s) => s.sessionId) }),
        ownerProfile: ownerId ? (profiles.get(ownerId) ?? null) : null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  res.json({
    devices: [...owned.map((row) => ({ ...row, online: presenceOf(row) })), ...shared],
  });
});

/** Revoke. A tombstone rather than a delete, so the row stays as an audit trail. */
app.delete('/v1/devices/:id', async (req, res) => {
  const userId = userIdOf(req);
  const at = new Date();
  // Ownership is established BEFORE the cascade, not alongside it. The device
  // update is scoped by userId and so matches nothing for someone else's machine,
  // but the grant cascade is keyed on deviceId alone — running it unconditionally
  // would let any signed-in user revoke the shares on a machine they merely know
  // the id of.
  const owned = await prisma.device.findFirst({
    where: { id: req.params.id, userId, revokedAt: null },
    select: { id: true },
  });
  if (!owned) {
    res.status(404).json({ error: 'unknown device' });
    return;
  }
  // One transaction: a machine that leaves the account must not leave guests
  // holding live access to it.
  await prisma.$transaction([
    prisma.device.updateMany({
      where: { id: owned.id, userId, revokedAt: null },
      data: { revokedAt: at },
    }),
    ...revokeGrantsForDevice(prisma, owned.id, at),
  ]);
  res.json({ ok: true });
});

/**
 * Let a machine release itself, proving possession of its own device secret.
 *
 * The machine cannot use `DELETE /v1/devices/:id` — that is Clerk-authenticated
 * and it holds no user token — so without this route a machine claimed by an
 * account whose owner cannot reach the web app is stuck for good: `register`
 * refuses to re-issue a code for a claimed row, and nothing else can clear it.
 *
 * Grants strictly less than the secret already does: whoever holds it can dial
 * `/agent` and drive the agent on that machine. It is still an unpair oracle, so
 * the compare is constant-time and every failure answers identically.
 *
 * Deliberately returns no pairing code. The machine calls `register` next, whose
 * revoked-row exception issues one — keeping exactly one code-issuing path.
 */
app.post('/v1/devices/unpair', async (req, res) => {
  const body = (req.body ?? {}) as { id?: string; secret?: string };
  if (!body.id || !body.secret) {
    res.status(400).json({ error: 'id and secret are required' });
    return;
  }
  const device = await prisma.device.findUnique({ where: { id: body.id } });
  const ok =
    device &&
    device.userId &&
    timingSafeEqualHex(device.secretHash, sha256(body.secret));
  if (!ok) {
    // One reply for unknown, never-claimed and wrong-secret: a distinct answer
    // would confirm a guessed id had once been real.
    res.status(403).json({ error: 'unauthorized' });
    return;
  }
  // A tombstone, identical to DELETE /v1/devices/:id: the row stays as an audit
  // trail and drops out of GET /v1/devices, which filters revokedAt: null. The
  // same grant cascade applies — the caller proved possession of the device
  // secret, which is exactly the authority the route already acts on.
  const at = new Date();
  await prisma.$transaction([
    prisma.device.update({ where: { id: device.id }, data: { revokedAt: at } }),
    ...revokeGrantsForDevice(prisma, device.id, at),
  ]);
  res.json({ ok: true });
});

/**
 * Verify a machine's secret. Called by the relay, not by browsers.
 *
 * Returns the owning userId so the relay can also assert that a browser asking
 * for this device belongs to the same user.
 */
app.post('/v1/devices/verify', async (req, res) => {
  const body = (req.body ?? {}) as { id?: string; secret?: string };
  if (!body.id || !body.secret) {
    res.status(400).json({ error: 'id and secret are required' });
    return;
  }
  const device = await prisma.device.findUnique({ where: { id: body.id } });
  const ok =
    device &&
    !device.revokedAt &&
    device.userId &&
    timingSafeEqualHex(device.secretHash, sha256(body.secret));
  if (!ok) {
    res.status(403).json({ error: 'unauthorized' });
    return;
  }
  await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  res.json({ userId: device.userId, appProtocol: device.appProtocol });
});

/**
 * Report whether a machine's bridge is attached. Called by the relay on hub
 * attach and detach, not by browsers.
 *
 * The relay is the only process that knows this, and it is also the most exposed
 * one in the system — so it pushes the transition over the channel it already
 * uses for /v1/devices/verify rather than growing a query surface of its own.
 *
 * `lastSeenAt` is stamped on both transitions: an attach is contact, and so is a
 * clean detach. That timestamp is what makes the flag believable (presenceOf) and
 * what a client falls back to when it is not.
 */
app.post('/v1/devices/presence', async (req, res) => {
  const body = (req.body ?? {}) as { deviceId?: string; online?: boolean };
  if (!body.deviceId || typeof body.online !== 'boolean') {
    res.status(400).json({ error: 'deviceId and online are required' });
    return;
  }
  // updateMany, not update: a revoked or unknown device simply matches nothing,
  // and a presence report must never resurrect a tombstoned row.
  const { count } = await prisma.device.updateMany({
    where: { id: body.deviceId, revokedAt: null },
    data: { online: body.online, lastSeenAt: new Date() },
  });
  if (!count) {
    res.status(404).json({ error: 'unknown device' });
    return;
  }
  res.json({ ok: true });
});

/**
 * The relay's grant oracle: may this browser's user reach this machine?
 *
 * Called with a user id the relay has already verified from a Clerk token. It
 * never sees or checks a device secret — that is /verify's job — so it answers
 * only the membership question, and answers `{allowed:false}` with nothing else
 * attached, so a probe learns nothing about a machine it cannot reach.
 */
app.post('/v1/devices/authorize', async (req, res) => {
  const body = (req.body ?? {}) as { deviceId?: string; userId?: string };
  if (!body.deviceId || !body.userId) {
    res.status(400).json({ error: 'deviceId and userId are required' });
    return;
  }
  const auth = await authorizeDevice(prisma, body.deviceId, body.userId);
  // Self-heal a missing display identity. The profile is normally cached at
  // invite and claim time, but a grant written before that existed — or one whose
  // Clerk lookup failed then — would leave a guest permanently nameless in
  // presence and on every prompt they send. Fill it in once, here, rather than
  // rendering "Someone" forever.
  if (auth.allowed && !auth.viewer) {
    await cacheProfile(body.userId);
    const viewer = await profileOf(prisma, body.userId);
    res.json({ ...auth, viewer });
    return;
  }
  res.json(auth);
});

/** Invite codes ride in a URL, so: URL-safe, and long enough not to be guessable. */
const inviteCode = () => randomBytes(24).toString('base64url');
const SHARE_INVITE_TTL_MIN = Number(process.env.SHARE_INVITE_TTL_MIN ?? 7 * 24 * 60);

/** Cache a Clerk identity so a shared session can name people without a Clerk key. */
async function cacheProfile(userId: string): Promise<void> {
  try {
    const user = await clerkClient.users.getUser(userId);
    const email =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ?? null;
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || null;
    const data = { email, name, imageUrl: user.imageUrl ?? null, updatedAt: new Date() };
    await prisma.userProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  } catch (err) {
    // Never fatal: a share works without a display name, and Clerk being slow or
    // down must not block a grant that is otherwise valid.
    console.warn(`[storage] could not cache profile for ${userId}:`, (err as Error).message);
  }
}

/** The caller's *verified* Clerk emails, lowercased. Unverified never matches an invite. */
async function verifiedEmails(userId: string): Promise<string[]> {
  const user = await clerkClient.users.getUser(userId);
  return user.emailAddresses
    .filter((e) => e.verification?.status === 'verified')
    .map((e) => e.emailAddress.toLowerCase());
}

/**
 * Mint an invite. Verifies the caller owns the machine — and, for a session
 * share, that the session exists under their own user — so an invite can never
 * be minted against someone else's machine or session.
 */
app.post('/v1/shares/invite', async (req, res) => {
  const userId = userIdOf(req);
  const body = (req.body ?? {}) as {
    deviceId?: string;
    sessionId?: string | null;
    inviteeEmail?: string | null;
    preset?: SharePreset;
  };
  const preset = body.preset ?? 'view';
  if (!body.deviceId || !SHARE_PRESETS[preset]) {
    res.status(400).json({ error: 'deviceId and a valid preset are required' });
    return;
  }
  const device = await prisma.device.findFirst({
    where: { id: body.deviceId, userId, revokedAt: null },
    select: { id: true },
  });
  if (!device) {
    res.status(404).json({ error: 'unknown device' });
    return;
  }
  if (body.sessionId) {
    const session = await prisma.session.findFirst({
      where: { userId, id: body.sessionId, deletedAt: null },
      select: { id: true },
    });
    if (!session) {
      res.status(404).json({ error: 'unknown session' });
      return;
    }
  }
  const code = inviteCode();
  const expiresAt = new Date(Date.now() + SHARE_INVITE_TTL_MIN * 60_000);
  // Lowercased on both sides of the comparison, so case can never deny a
  // legitimate invitee — and shared with the contact row, so the two cannot drift.
  const inviteeEmail = normalizeEmail(body.inviteeEmail);
  await prisma.shareInvite.create({
    data: {
      code,
      ownerId: userId,
      deviceId: device.id,
      sessionId: body.sessionId ?? null,
      inviteeEmail,
      caps: capsJson(capsForPreset(preset, body.sessionId ? 'session' : 'machine')),
      expiresAt,
    },
  });
  await cacheProfile(userId);
  // Remembered here rather than derived from the invite later: an invite expires
  // in a week and a grant can be revoked, but the address stays worth offering.
  await recordShareContact(prisma, userId, inviteeEmail);
  res.json({ code, expiresAt: expiresAt.toISOString() });
});

/** Grants this user made and holds, for the share overlay and the machine picker. */
app.get('/v1/shares', async (req, res) => {
  const userId = userIdOf(req);
  const [grantedMembers, grantedShares, invites, receivedMembers, receivedShares] =
    await Promise.all([
      prisma.deviceMember.findMany({ where: { ownerId: userId, revokedAt: null } }),
      prisma.sessionShare.findMany({ where: { ownerId: userId, revokedAt: null } }),
      prisma.shareInvite.findMany({
        where: { ownerId: userId, revokedAt: null, claimedBy: null, expiresAt: { gt: new Date() } },
      }),
      prisma.deviceMember.findMany({ where: { userId, revokedAt: null } }),
      prisma.sessionShare.findMany({ where: { userId, revokedAt: null } }),
    ]);

  const ids = new Set<string>([
    ...grantedMembers.map((m) => m.userId),
    ...grantedShares.map((s) => s.userId),
    ...receivedMembers.map((m) => m.ownerId),
    ...receivedShares.map((s) => s.ownerId),
  ]);
  const profiles = new Map(
    (await prisma.userProfile.findMany({ where: { userId: { in: [...ids] } } })).map((p) => [
      p.userId,
      { userId: p.userId, email: p.email, name: p.name, imageUrl: p.imageUrl },
    ]),
  );

  res.json({
    granted: [
      ...grantedMembers.map((m) => ({
        kind: 'machine' as const,
        deviceId: m.deviceId,
        userId: m.userId,
        caps: parseShareCaps(m.caps),
        preset: presetOfCaps(parseShareCaps(m.caps), 'machine'),
        createdAt: m.createdAt,
        profile: profiles.get(m.userId) ?? null,
      })),
      ...grantedShares.map((s) => ({
        kind: 'session' as const,
        deviceId: s.deviceId,
        sessionId: s.sessionId,
        userId: s.userId,
        caps: parseShareCaps(s.caps),
        preset: presetOfCaps(parseShareCaps(s.caps), 'session'),
        createdAt: s.createdAt,
        profile: profiles.get(s.userId) ?? null,
      })),
    ],
    // Pending invites sit alongside accepted members so an unclaimed one is
    // visible and revocable rather than invisible until someone uses it.
    invites: invites.map((i) => ({
      code: i.code,
      deviceId: i.deviceId,
      sessionId: i.sessionId,
      inviteeEmail: i.inviteeEmail,
      preset: presetOfCaps(parseShareCaps(i.caps), i.sessionId ? 'session' : 'machine'),
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
    })),
    received: [
      ...receivedMembers.map((m) => ({
        kind: 'machine' as const,
        deviceId: m.deviceId,
        ownerId: m.ownerId,
        caps: parseShareCaps(m.caps),
        profile: profiles.get(m.ownerId) ?? null,
      })),
      ...receivedShares.map((s) => ({
        kind: 'session' as const,
        deviceId: s.deviceId,
        sessionId: s.sessionId,
        ownerId: s.ownerId,
        caps: parseShareCaps(s.caps),
        profile: profiles.get(s.ownerId) ?? null,
      })),
    ],
  });
});

/**
 * Invitations waiting for *this* user, found by their verified email rather than
 * by holding the link.
 *
 * Without this, an invitee who signs in before opening the link — or who loses
 * it — reaches the "connect a machine" screen with no way forward and no sign
 * that they have been invited to anything. Accepting a share must not depend on
 * still having a URL.
 *
 * Only address-bound invites appear. A link-only invite is a bearer token
 * addressed to nobody, so listing it for any signed-in user would turn "single
 * use link" into "anyone with an account".
 */
app.get('/v1/shares/pending', async (req, res) => {
  const userId = userIdOf(req);
  const emails = await verifiedEmails(userId).catch(() => [] as string[]);
  if (!emails.length) {
    res.json({ invites: [] });
    return;
  }
  const invites = await prisma.shareInvite.findMany({
    where: {
      inviteeEmail: { in: emails },
      claimedBy: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      // Your own invite is not a pending invitation to you.
      NOT: { ownerId: userId },
    },
    orderBy: { createdAt: 'desc' },
  });
  const [devices, owners] = await Promise.all([
    prisma.device.findMany({
      where: { id: { in: invites.map((i) => i.deviceId) }, revokedAt: null },
      select: { id: true, name: true },
    }),
    prisma.userProfile.findMany({ where: { userId: { in: invites.map((i) => i.ownerId) } } }),
  ]);
  const deviceName = new Map(devices.map((d) => [d.id, d.name]));
  const profiles = new Map(
    owners.map((p) => [p.userId, { userId: p.userId, email: p.email, name: p.name, imageUrl: p.imageUrl }]),
  );
  res.json({
    invites: invites
      // An invite whose machine has since been unpaired grants nothing; offering
      // it would be a button that fails.
      .filter((i) => deviceName.has(i.deviceId))
      .map((i) => ({
        code: i.code,
        scope: i.sessionId ? 'session' : 'machine',
        machineName: deviceName.get(i.deviceId) ?? null,
        owner: profiles.get(i.ownerId) ?? null,
        preset: presetOfCaps(parseShareCaps(i.caps), i.sessionId ? 'session' : 'machine'),
        expiresAt: i.expiresAt,
      })),
  });
});

/**
 * Preview for the /join page. Signed-in only, and deliberately says nothing an
 * unauthenticated holder of a leaked link could use: never the invitee's email,
 * and nothing at all once the invite is spent.
 */
app.get('/v1/shares/invite/:code', async (req, res) => {
  const userId = userIdOf(req);
  const invite = await prisma.shareInvite.findUnique({ where: { code: req.params.code } });
  if (!invite || invite.revokedAt || invite.claimedBy || invite.expiresAt < new Date()) {
    res.status(404).json({ error: 'unknown or expired invite' });
    return;
  }
  const [device, owner] = await Promise.all([
    prisma.device.findUnique({ where: { id: invite.deviceId }, select: { name: true } }),
    profileOf(prisma, invite.ownerId),
  ]);
  const session = invite.sessionId
    ? await prisma.session.findFirst({
        where: { userId: invite.ownerId, id: invite.sessionId, deletedAt: null },
        select: { data: true },
      })
    : null;
  res.json({
    code: invite.code,
    scope: invite.sessionId ? 'session' : 'machine',
    machineName: device?.name ?? null,
    sessionName: (session?.data as { name?: string } | null)?.name ?? null,
    owner,
    preset: presetOfCaps(parseShareCaps(invite.caps), invite.sessionId ? 'session' : 'machine'),
    /** So the page can say "this is your own invite" rather than a bare refusal. */
    isOwn: invite.ownerId === userId,
    expiresAt: invite.expiresAt,
  });
});

/**
 * Redeem an invite. Single use, enforced as a compare-and-set on `claimedBy` in
 * the same transaction that writes the grant — a replayed code finds nothing to
 * update and 409s rather than minting a second grant.
 */
app.post('/v1/shares/claim', async (req, res) => {
  const userId = userIdOf(req);
  const code = String((req.body as { code?: string } | null)?.code ?? '').trim();
  const invite = await prisma.shareInvite.findUnique({ where: { code } });
  if (!invite || invite.revokedAt || invite.expiresAt < new Date()) {
    res.status(404).json({ error: 'unknown or expired invite' });
    return;
  }
  if (invite.claimedBy) {
    res.status(409).json({ error: 'this invite has already been used' });
    return;
  }
  if (invite.ownerId === userId) {
    res.status(400).json({ error: 'this is your own invite' });
    return;
  }
  if (invite.inviteeEmail) {
    // The likeliest real-world failure is signing up with a different address
    // than the one invited, so the error names it instead of a bare denial.
    // Unverified addresses never match: otherwise anyone could add the invitee's
    // email to their own account and claim in their place.
    const mine = await verifiedEmails(userId).catch(() => [] as string[]);
    if (!mine.includes(invite.inviteeEmail)) {
      res.status(403).json({
        error: `This invite was sent to ${invite.inviteeEmail}. Sign in with that address to accept it.`,
      });
      return;
    }
  }
  // The machine must still exist, still belong to the inviter, and still be live:
  // an invite minted before an unpair must not grant access to whoever holds that
  // device id now.
  const device = await prisma.device.findFirst({
    where: { id: invite.deviceId, userId: invite.ownerId, revokedAt: null },
    select: { id: true },
  });
  if (!device) {
    res.status(404).json({ error: 'that machine is no longer available' });
    return;
  }

  const claimed = await prisma.$transaction(async (tx) => {
    // Compare-and-set: `claimedBy: null` in the where clause is what makes two
    // concurrent claims resolve to exactly one grant.
    const { count } = await tx.shareInvite.updateMany({
      where: { code: invite.code, claimedBy: null, revokedAt: null },
      data: { claimedBy: userId, claimedAt: new Date() },
    });
    if (!count) return false;
    const caps = invite.caps as Record<string, boolean>;
    if (invite.sessionId) {
      await tx.sessionShare.upsert({
        where: {
          deviceId_userId_sessionId: {
            deviceId: invite.deviceId,
            userId,
            sessionId: invite.sessionId,
          },
        },
        create: {
          deviceId: invite.deviceId,
          userId,
          sessionId: invite.sessionId,
          ownerId: invite.ownerId,
          caps,
        },
        // Re-claiming a previously revoked grant clears the tombstone rather than
        // failing on the primary key.
        update: { caps, ownerId: invite.ownerId, revokedAt: null },
      });
    } else {
      await tx.deviceMember.upsert({
        where: { deviceId_userId: { deviceId: invite.deviceId, userId } },
        create: { deviceId: invite.deviceId, userId, ownerId: invite.ownerId, caps },
        update: { caps, ownerId: invite.ownerId, revokedAt: null },
      });
    }
    return true;
  });
  if (!claimed) {
    res.status(409).json({ error: 'this invite has already been used' });
    return;
  }
  await cacheProfile(userId);
  // The owner now knows this person, whichever way the invite reached them. A
  // link-only invite carries no address, so fall back to the primary email just
  // cached — that is the whole reason claiming a link records anything at all.
  const claimer = invite.inviteeEmail ?? (await profileOf(prisma, userId))?.email ?? null;
  await recordShareContact(prisma, invite.ownerId, claimer, userId);
  res.json({
    ok: true,
    deviceId: invite.deviceId,
    sessionId: invite.sessionId,
    scope: invite.sessionId ? 'session' : 'machine',
  });
});

/**
 * Narrow or widen a live grant without revoking and re-inviting. Owner only —
 * scoped by ownerId in the where clause, so a grantee cannot raise their own.
 */
app.patch('/v1/shares/:kind/:id', async (req, res) => {
  const ownerId = userIdOf(req);
  const preset = (req.body as { preset?: SharePreset } | null)?.preset;
  const granteeId = (req.body as { userId?: string } | null)?.userId;
  const sessionId = (req.body as { sessionId?: string } | null)?.sessionId;
  if (!preset || !SHARE_PRESETS[preset]) {
    res.status(400).json({ error: 'a valid preset is required' });
    return;
  }
  const { kind, id } = req.params;
  if (kind === 'machine') {
    if (!granteeId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    const { count } = await prisma.deviceMember.updateMany({
      where: { deviceId: id, userId: granteeId, ownerId, revokedAt: null },
      data: { caps: capsJson(capsForPreset(preset, 'machine')) },
    });
    res.status(count ? 200 : 404).json(count ? { ok: true } : { error: 'unknown grant' });
    return;
  }
  if (kind === 'session') {
    if (!granteeId || !sessionId) {
      res.status(400).json({ error: 'userId and sessionId are required' });
      return;
    }
    const { count } = await prisma.sessionShare.updateMany({
      where: { deviceId: id, userId: granteeId, sessionId, ownerId, revokedAt: null },
      data: { caps: capsJson(capsForPreset(preset, 'session')) },
    });
    res.status(count ? 200 : 404).json(count ? { ok: true } : { error: 'unknown grant' });
    return;
  }
  res.status(400).json({ error: 'unknown share kind' });
});

/**
 * Revoke a grant or an unclaimed invite. A tombstone, matching every other
 * revocation here, and always scoped by ownerId: a grantee can revoke nothing.
 */
app.delete('/v1/shares/:kind/:id', async (req, res) => {
  const ownerId = userIdOf(req);
  const { kind, id } = req.params;
  const granteeId = String(req.query.userId ?? '');
  const sessionId = String(req.query.sessionId ?? '');
  const at = new Date();

  if (kind === 'invite') {
    const { count } = await prisma.shareInvite.updateMany({
      where: { code: id, ownerId, revokedAt: null },
      data: { revokedAt: at },
    });
    res.status(count ? 200 : 404).json(count ? { ok: true } : { error: 'unknown invite' });
    return;
  }
  if (kind === 'machine') {
    const { count } = await prisma.deviceMember.updateMany({
      where: { deviceId: id, userId: granteeId, ownerId, revokedAt: null },
      data: { revokedAt: at },
    });
    res.status(count ? 200 : 404).json(count ? { ok: true } : { error: 'unknown grant' });
    return;
  }
  if (kind === 'session') {
    const { count } = await prisma.sessionShare.updateMany({
      // No sessionId revokes every session share this user holds on the machine.
      where: {
        deviceId: id,
        userId: granteeId,
        ownerId,
        revokedAt: null,
        ...(sessionId ? { sessionId } : {}),
      },
      data: { revokedAt: at },
    });
    res.status(count ? 200 : 404).json(count ? { ok: true } : { error: 'unknown grant' });
    return;
  }
  res.status(400).json({ error: 'unknown share kind' });
});

/**
 * The collaborator address book: people this account has shared with, newest
 * first, so the share overlay can offer them instead of asking for an address
 * from memory.
 *
 * Not derived from grants or invites on purpose — those are revoked, claimed or
 * expired within a week, and the address of someone whose access you revoked is
 * exactly the one you still want offered.
 */
app.get('/v1/contacts', async (req, res) => {
  const ownerId = userIdOf(req);
  const contacts = await prisma.shareContact.findMany({
    where: { ownerId },
    orderBy: { lastUsedAt: 'desc' },
    take: 50,
  });
  // Only the ones who have claimed carry a user id, so only they can be named.
  const ids = contacts.map((c) => c.userId).filter((id): id is string => Boolean(id));
  const profiles = new Map(
    (await prisma.userProfile.findMany({ where: { userId: { in: ids } } })).map((p) => [p.userId, p]),
  );
  res.json({
    contacts: contacts.map((c) => {
      const profile = c.userId ? profiles.get(c.userId) : null;
      return {
        email: c.email,
        name: profile?.name ?? null,
        imageUrl: profile?.imageUrl ?? null,
        userId: c.userId,
        lastUsedAt: c.lastUsedAt,
      };
    }),
  });
});

/**
 * Forget one collaborator. A real delete, not a tombstone: this list exists only
 * to be offered back, so "remove" has to mean the address stops being kept.
 */
app.delete('/v1/contacts/:email', async (req, res) => {
  const ownerId = userIdOf(req);
  const email = normalizeEmail(req.params.email);
  if (!email) {
    res.status(400).json({ error: 'an email is required' });
    return;
  }
  const count = await forgetShareContact(prisma, ownerId, email);
  res.status(count ? 200 : 404).json(count ? { ok: true } : { error: 'unknown contact' });
});

/** Forget everyone. Scoped by ownerId, so it can only ever empty your own list. */
app.delete('/v1/contacts', async (req, res) => {
  const ownerId = userIdOf(req);
  const { count } = await prisma.shareContact.deleteMany({ where: { ownerId } });
  res.json({ ok: true, count });
});

/** Constant-time compare of two hex digests of equal length. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Constant-time compare for arbitrary strings. Hashed first so the comparison
 * runs over two fixed-length buffers: timingSafeEqual throws on a length
 * mismatch, and returning early on that would leak the secret's length.
 */
function timingSafeEqualUtf8(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));
}

// Express 5 forwards async route rejections here.
const onError: ErrorRequestHandler = (err, req, res, _next) => {
  // Body-parser rejection. Answered as JSON 413 rather than the generic 500 so
  // the bridge reads the real reason instead of raising a blanket outage banner.
  if ((err as { type?: string })?.type === 'entity.too.large') {
    console.warn(`[storage] payload too large: ${req.method} ${req.path} (${(err as { length?: number }).length} bytes)`);
    res.status(413).json({ error: 'payload too large' });
    return;
  }
  console.error('[storage]', err);
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
};
app.use(onError);

app.listen(PORT, () => {
  console.log(`lines storage listening on http://localhost:${PORT}`);
});
