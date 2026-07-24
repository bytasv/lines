/**
 * Storage-only server (:8790): durable per-user workflows/settings/session
 * metadata in Supabase Postgres via Prisma. No CLI, no filesystem, no agent
 * execution. Every request authenticates a Clerk token; all rows are scoped
 * by the verified userId — the bridge forwards user tokens, never re-signs.
 */
import path from 'node:path';
import dotenv from 'dotenv';
import type { ErrorRequestHandler, Request } from 'express';

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

const PORT = Number(process.env.PORT ?? 8790);

const app = express();
app.use(express.json({ limit: '2mb' }));

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

// --- workflows -------------------------------------------------------------

app.get('/workflows', async (req, res) => {
  const rows = await prisma.workflow.findMany({ where: { userId: userIdOf(req) } });
  res.json(rows.map((r) => r.data));
});

/** Every other user's published workflows — the cross-user read path. */
app.get('/workflows/shared', async (req, res) => {
  const userId = userIdOf(req);
  const rows = await prisma.workflow.findMany({
    where: { published: true, NOT: { userId } },
  });
  // Guarantee ownerId even for blobs saved before the column existed.
  res.json(rows.map((r) => ({ ...(r.data as object), ownerId: (r.data as { ownerId?: string }).ownerId ?? r.userId })));
});

app.put('/workflows', async (req, res) => {
  const userId = userIdOf(req);
  const list = Array.isArray(req.body) ? (req.body as { id?: string; published?: boolean }[]) : [];
  for (const wf of list) {
    if (!wf?.id) continue;
    const published = wf.published === true;
    await prisma.workflow.upsert({
      where: { userId_id: { userId, id: wf.id } },
      create: { userId, id: wf.id, data: wf as object, published, updatedAt: updatedAtOf(wf) },
      update: { data: wf as object, published, updatedAt: updatedAtOf(wf) },
    });
  }
  res.json({ ok: true, count: list.length });
});

app.delete('/workflows/:id', async (req, res) => {
  await prisma.workflow
    .delete({ where: { userId_id: { userId: userIdOf(req), id: req.params.id } } })
    .catch(() => undefined); // deleting a never-synced row is fine
  res.json({ ok: true });
});

// --- steps (versioned, shareable) ------------------------------------------

/** Reduce version rows to the head (highest version) per step id. */
function heads(rows: { id: string; version: number; data: unknown }[]): unknown[] {
  const byId = new Map<string, { version: number; data: unknown }>();
  for (const r of rows) {
    const cur = byId.get(r.id);
    if (!cur || r.version > cur.version) byId.set(r.id, { version: r.version, data: r.data });
  }
  return [...byId.values()].map((v) => v.data);
}

app.get('/steps', async (req, res) => {
  // All of the caller's own steps (published or not) — their private library.
  const rows = await prisma.stepVersion.findMany({ where: { userId: userIdOf(req) } });
  res.json(heads(rows));
});

/** Every other user's published steps, head version only — the library. */
app.get('/steps/shared', async (req, res) => {
  const rows = await prisma.stepVersion.findMany({ where: { published: true, NOT: { userId: userIdOf(req) } } });
  res.json(heads(rows));
});

app.put('/steps', async (req, res) => {
  const userId = userIdOf(req);
  const list = Array.isArray(req.body) ? (req.body as { id?: string; version?: number; published?: boolean }[]) : [];
  for (const step of list) {
    if (!step?.id || typeof step.version !== 'number') continue;
    const published = step.published !== false;
    await prisma.stepVersion.upsert({
      where: { userId_id_version: { userId, id: step.id, version: step.version } },
      create: { userId, id: step.id, version: step.version, data: step as object, published, updatedAt: updatedAtOf(step) },
      update: { data: step as object, published, updatedAt: updatedAtOf(step) },
    });
  }
  res.json({ ok: true, count: list.length });
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
    where: { OR: valid.map((r) => ({ userId: r.ownerId!, id: r.id!, version: r.version! })) },
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

// --- sessions (metadata only) ----------------------------------------------

app.get('/sessions', async (req, res) => {
  const rows = await prisma.session.findMany({ where: { userId: userIdOf(req) } });
  res.json(rows.map((r) => r.data));
});

app.put('/sessions', async (req, res) => {
  const userId = userIdOf(req);
  const list = Array.isArray(req.body) ? (req.body as { id?: string }[]) : [];
  for (const meta of list) {
    if (!meta?.id) continue;
    await prisma.session.upsert({
      where: { userId_id: { userId, id: meta.id } },
      create: { userId, id: meta.id, data: meta as object, updatedAt: updatedAtOf(meta) },
      update: { data: meta as object, updatedAt: updatedAtOf(meta) },
    });
  }
  res.json({ ok: true, count: list.length });
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
  });
  res.json({ ok: true });
});

app.delete('/sessions/:id', async (req, res) => {
  await prisma.session
    .delete({ where: { userId_id: { userId: userIdOf(req), id: req.params.id } } })
    .catch(() => undefined);
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
 */
app.put('/project-keys', async (req, res) => {
  const userId = userIdOf(req);
  const incoming = req.body as Record<string, unknown> | null;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    res.status(400).json({ error: 'body must be an object' });
    return;
  }
  const row = await prisma.projectKeys.findUnique({ where: { userId } });
  const merged = { ...((row?.data as Record<string, string>) ?? {}) };
  for (const [cwd, key] of Object.entries(incoming)) {
    if (typeof key === 'string' && key && !merged[cwd]) merged[cwd] = key;
  }
  await prisma.projectKeys.upsert({
    where: { userId },
    create: { userId, data: merged, updatedAt: new Date() },
    update: { data: merged, updatedAt: new Date() },
  });
  res.json({ ok: true, count: Object.keys(merged).length });
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
  });
  res.json({ ok: true });
});

// Express 5 forwards async route rejections here.
const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('[storage]', err);
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
};
app.use(onError);

app.listen(PORT, () => {
  console.log(`claude-ui storage listening on http://localhost:${PORT}`);
});
