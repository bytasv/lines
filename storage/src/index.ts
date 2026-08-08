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
import { RECIPE_IMAGE_MAX_BYTES, RECIPE_IMAGE_TYPES } from '@lines/shared';
import { putRecipeImage, r2Configured, r2PublicBaseWarning } from './r2.ts';

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  console.warn('[storage] DATABASE_URL not set — storage server not starting');
  process.exit(0);
}
if (!process.env.CLERK_SECRET_KEY) {
  console.warn('[storage] CLERK_SECRET_KEY not set — storage server not starting');
  process.exit(0);
}

const [{ default: express }, { clerkMiddleware, getAuth }, { prisma }] = await Promise.all([
  import('express'),
  import('@clerk/express'),
  import('./db.ts'),
]);

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

app.use(
  clerkMiddleware({
    secretKey: process.env.CLERK_SECRET_KEY,
    // Reuse the web app's key — same Clerk instance, one .env entry.
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? process.env.VITE_CLERK_PUBLISHABLE_KEY,
  }),
);
// API-style 401 (requireAuth() redirects browsers to sign-in — wrong for a JSON API).
app.use((req, res, next) => {
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
    select: { data: true, updatedAt: true },
  });
  stampCursor(res, rows);
  res.json(rows.map((r) => r.data));
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
  // Guarantee ownerId even for blobs saved before the column existed.
  res.json(rows.map((r) => ({ ...(r.data as object), ownerId: (r.data as { ownerId?: string }).ownerId ?? r.userId })));
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
  await prisma.$executeRaw`
    INSERT INTO workflows (user_id, id, data, published, updated_at)
    SELECT ${userId}, u.id, u.data::jsonb, u.published, u.updated_at
    FROM UNNEST(
      ${valid.map((wf) => wf.id!)}::text[],
      ${valid.map((wf) => JSON.stringify(wf))}::text[],
      ${valid.map((wf) => wf.published === true)}::bool[],
      ${valid.map((wf) => updatedAtOf(wf).toISOString())}::timestamptz[]
    ) AS u(id, data, published, updated_at)
    ON CONFLICT (user_id, id) DO UPDATE
      SET data = EXCLUDED.data, published = EXCLUDED.published, updated_at = EXCLUDED.updated_at`;
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
  const rows = since
    ? await prisma.$queryRaw<{ data: unknown; updatedAt: Date }[]>`
        SELECT DISTINCT ON (user_id, id) data, updated_at AS "updatedAt" FROM step_versions
        WHERE user_id = ${userId} AND updated_at >= ${since}
        ORDER BY user_id, id, version DESC`
    : await prisma.$queryRaw<{ data: unknown; updatedAt: Date }[]>`
        SELECT DISTINCT ON (user_id, id) data, updated_at AS "updatedAt" FROM step_versions
        WHERE user_id = ${userId}
        ORDER BY user_id, id, version DESC`;
  stampCursor(res, rows);
  res.json(rows.map((r) => r.data));
});

/** Every other user's published steps, head version only — the library. */
app.get('/steps/shared', async (req, res) => {
  const userId = userIdOf(req);
  const [tag] = await prisma.$queryRaw<{ count: bigint; max: Date | null }[]>`
    SELECT count(*) AS count, max(updated_at) AS max FROM step_versions
    WHERE published AND user_id <> ${userId}`;
  if (servedFromEtag(req, res, tag)) return;
  const rows = await prisma.$queryRaw<{ data: unknown }[]>`
    SELECT DISTINCT ON (user_id, id) data FROM step_versions
    WHERE published AND user_id <> ${userId}
    ORDER BY user_id, id, version DESC`;
  res.json(rows.map((r) => r.data));
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
  await prisma.$executeRaw`
    INSERT INTO step_versions (user_id, id, version, data, published, updated_at)
    SELECT ${userId}, u.id, u.version, u.data::jsonb, u.published, u.updated_at
    FROM UNNEST(
      ${valid.map((s) => s.id!)}::text[],
      ${valid.map((s) => s.version!)}::int[],
      ${valid.map((s) => JSON.stringify(s))}::text[],
      ${valid.map((s) => s.published !== false)}::bool[],
      ${valid.map((s) => updatedAtOf(s).toISOString())}::timestamptz[]
    ) AS u(id, version, data, published, updated_at)
    ON CONFLICT (user_id, id, version) DO UPDATE
      SET data = EXCLUDED.data, published = EXCLUDED.published, updated_at = EXCLUDED.updated_at`;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ceiling on one /sessions pull. Sessions are never deleted from storage by
 * age, so without this the newest install re-downloads years of metadata. The
 * bridge keeps its own full copy on disk; this only bounds what a *sync* moves.
 */
const SESSIONS_PAGE_MAX = 500;

app.get('/sessions', async (req, res) => {
  // The heaviest pull in the system — session metadata accumulates forever and
  // the UI only ever shows the recent end of it. Bounded even on a full pull.
  //
  // Direction matters with `take`. A full pull wants the newest page (`desc`),
  // and the cursor it hands back is the newest row — everything older is
  // deliberately left behind. A delta pull walks *forward* (`asc`), so when
  // more than a page has changed the cursor lands on the oldest unsent row and
  // the next pull resumes there; newest-first would strand the remainder.
  const since = sinceOf(req);
  const rows = await prisma.session.findMany({
    where: { userId: userIdOf(req), ...(since ? { updatedAt: { gte: since } } : {}) },
    select: { data: true, updatedAt: true },
    orderBy: { updatedAt: since ? 'asc' : 'desc' },
    take: SESSIONS_PAGE_MAX,
  });
  stampCursor(res, rows);
  res.json(rows.map((r) => r.data));
});

app.put('/sessions', async (req, res) => {
  const userId = userIdOf(req);
  const list = Array.isArray(req.body) ? (req.body as { id?: string }[]) : [];
  // sessions.id is a uuid column and this is now one batched statement, so a
  // single malformed id would reject the whole push — drop those instead.
  const valid = list.filter((m) => m?.id && UUID_RE.test(m.id));
  if (valid.length === 0) {
    res.json({ ok: true, count: 0 });
    return;
  }
  await prisma.$executeRaw`
    INSERT INTO sessions (user_id, id, data, updated_at)
    SELECT ${userId}, u.id::uuid, u.data::jsonb, u.updated_at
    FROM UNNEST(
      ${valid.map((m) => m.id!)}::text[],
      ${valid.map((m) => JSON.stringify(m))}::text[],
      ${valid.map((m) => updatedAtOf(m).toISOString())}::timestamptz[]
    ) AS u(id, data, updated_at)
    ON CONFLICT (user_id, id) DO UPDATE
      SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`;
  res.json({ ok: true, count: valid.length });
});

app.put('/sessions/:id', async (req, res) => {
  const userId = userIdOf(req);
  const meta = req.body as { id?: string };
  if (!meta?.id || meta.id !== req.params.id) {
    res.status(400).json({ error: 'body id must match path id' });
    return;
  }
  await prisma.session.upsert({
    where: { userId_id: { userId, id: meta.id } },
    create: { userId, id: meta.id, data: meta as object, updatedAt: updatedAtOf(meta) },
    update: { data: meta as object, updatedAt: updatedAtOf(meta) },
    select: { userId: true }, // never return the blob we just sent
  });
  res.json({ ok: true });
});

app.delete('/sessions/:id', async (req, res) => {
  await prisma.session
    .deleteMany({ where: { userId: userIdOf(req), id: req.params.id } })
    .catch(() => undefined); // a malformed (non-uuid) id is not worth a 500
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
  const existing = await prisma.device.findUnique({ where: { id: body.id } });
  if (existing?.userId) {
    res.status(409).json({ error: 'device already paired' });
    return;
  }
  await prisma.device.upsert({
    where: { id: body.id },
    create: { id: body.id, ...data },
    update: data,
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

/** This user's devices. Never returns secretHash. */
app.get('/v1/devices', async (req, res) => {
  const devices = await prisma.device.findMany({
    where: { userId: userIdOf(req), revokedAt: null },
    select: { id: true, name: true, platform: true, appProtocol: true, createdAt: true, lastSeenAt: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ devices });
});

/** Revoke. A tombstone rather than a delete, so the row stays as an audit trail. */
app.delete('/v1/devices/:id', async (req, res) => {
  const userId = userIdOf(req);
  // Scoped by userId in the where clause: another user's id simply matches nothing.
  const { count } = await prisma.device.updateMany({
    where: { id: req.params.id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (!count) {
    res.status(404).json({ error: 'unknown device' });
    return;
  }
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

/** Constant-time compare of two hex digests of equal length. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// Express 5 forwards async route rejections here.
const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('[storage]', err);
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
};
app.use(onError);

app.listen(PORT, () => {
  console.log(`lines storage listening on http://localhost:${PORT}`);
});
