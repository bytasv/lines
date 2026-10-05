import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import type { SessionDiffResponse, SessionMeta } from '@lines/shared';
import { OWNER_ACCESS } from '@lines/shared';
import { handleFileRequest, MAX_MEDIA_BYTES, MEDIA_CHUNK_BYTES } from './fileRoutes.ts';
import type { UserContext } from './userContext.ts';

/**
 * These used to be HTTP GETs with the Clerk token in the query string. The
 * behaviour they encode — root containment, the size and binary rejections, the
 * all-or-nothing find — is unchanged; only the transport moved.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-fileroutes-'));
const attachments = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-attach-'));
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(attachments, { recursive: true, force: true });
});

fs.writeFileSync(path.join(root, 'hello.txt'), 'hi there');
fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0x41, 0x00, 0x42]));
fs.mkdirSync(path.join(root, 'sub'));
fs.mkdirSync(path.join(root, 'node_modules'));
fs.writeFileSync(path.join(root, '.hidden'), 'x');
// Media fixtures: a NUL byte the `file` kind would 415 on, and a clip spanning
// several chunks with a short last one.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]);
fs.writeFileSync(path.join(root, 'pic.png'), PNG);
const CLIP = Buffer.alloc(Math.floor(2.5 * 1024 * 1024), 0xab);
CLIP.writeUInt32BE(0xdeadbeef, CLIP.length - 4);
fs.writeFileSync(path.join(root, 'clip.mp4'), CLIP);
fs.writeFileSync(path.join(attachments, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

const EMPTY_DIFF: SessionDiffResponse = { repos: [], orphans: [] };

/** Only the members the routes actually read. */
function ctx(sessions: Partial<UserContext['sessions']> = {}): UserContext {
  return {
    store: { loadProjects: () => [{ path: root }], attachmentsRoot: attachments },
    sessions: {
      list: () => [] as SessionMeta[],
      changeSummary: async (id: string) => (id === 'known' ? EMPTY_DIFF : null),
      baselineRefFor: async (id: string, repo: string) =>
        id === 'known' && repo === root ? 'HEAD' : null,
      ...sessions,
    },
  } as unknown as UserContext;
}

/** These cases are the owner's, whose access is unrestricted — the guest clamp
 *  has its own tests in guestAccess.test.ts. */
const call = (kind: Parameters<typeof handleFileRequest>[1], params = {}) =>
  handleFileRequest(ctx(), kind, params, OWNER_ACCESS);

test('file: reads a file inside a project root', async () => {
  const res = await call('file', { paths: [path.join(root, 'hello.txt')] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    content: 'hi there',
    mtimeMs: fs.statSync(path.join(root, 'hello.txt')).mtimeMs,
  });
});

test('file: 403 outside every root, 404 when missing', async () => {
  assert.equal((await call('file', { paths: ['/etc/hosts'] })).status, 403);
  assert.equal((await call('file', { paths: [path.join(root, 'nope.txt')] })).status, 404);
  // A directory is not a file.
  assert.equal((await call('file', { paths: [path.join(root, 'sub')] })).status, 404);
});

test('file: 415 on binary content', async () => {
  // NUL in the first 8KB — the same probe the HTTP route used.
  assert.equal((await call('file', { paths: [path.join(root, 'binary.bin')] })).status, 415);
});

test('file: a missing path is 403, not a crash', async () => {
  assert.equal((await call('file', {})).status, 403);
});

test('tree: lists entries including dotfiles, hiding node_modules', async () => {
  const res = await call('tree', { paths: [root] });
  assert.equal(res.status, 200);
  const names = (res.body as { entries: { name: string }[] }).entries.map((e) => e.name);
  assert.deepEqual(names, ['sub', '.hidden', 'binary.bin', 'clip.mp4', 'hello.txt', 'pic.png']); // dirs first, then alpha
  assert.ok(!names.includes('node_modules'));
});

test('tree: 403 outside every root', async () => {
  assert.equal((await call('tree', { paths: ['/etc'] })).status, 403);
});

test('find: searches across roots', async () => {
  const res = await call('find', { paths: [root], q: 'hello' });
  assert.equal(res.status, 200);
  const files = (res.body as { files: { rel: string }[] }).files;
  assert.ok(files.some((f) => f.rel === 'hello.txt'));
});

test('find: one bad root fails the whole request', async () => {
  // All-or-nothing on purpose: a partial result reads as "no match here" and
  // would silently hide a whole folder from the mention list.
  assert.equal((await call('find', { paths: [root, '/etc'], q: 'hello' })).status, 403);
  assert.equal((await call('find', { paths: [], q: 'hello' })).status, 403);
});

test('find: limit is capped regardless of what the client asks for', async () => {
  const res = await call('find', { paths: [root], q: '', limit: 10_000 });
  assert.equal(res.status, 200);
  assert.ok((res.body as { files: unknown[] }).files.length <= 25);
});

test('attachment: returns base64 plus a media type', async () => {
  const res = await call('attachment', { rel: 'pic.png' });
  assert.equal(res.status, 200);
  const body = res.body as { data: string; mediaType: string };
  assert.equal(body.mediaType, 'image/png');
  assert.deepEqual([...Buffer.from(body.data, 'base64')], [0x89, 0x50, 0x4e, 0x47]);
});

test('attachment: path traversal is refused', async () => {
  // The attachments root is the only thing this route may read, so escaping it
  // must fail even though the target exists and is readable.
  assert.equal((await call('attachment', { rel: '../../etc/hosts' })).status, 403);
  assert.equal((await call('attachment', { rel: 'missing.png' })).status, 404);
});

type MediaBody = { data: string; mediaType: string; size: number };

test('media: returns base64, the media type, and the whole file size', async () => {
  const res = await call('media', { paths: [path.join(root, 'pic.png')] });
  assert.equal(res.status, 200);
  const body = res.body as MediaBody;
  assert.equal(body.mediaType, 'image/png');
  assert.equal(body.size, PNG.length);
  assert.deepEqual(Buffer.from(body.data, 'base64'), PNG);
});

test('media: chunks are clamped, the last is the remainder, and they rebuild the file', async () => {
  const clip = path.join(root, 'clip.mp4');
  const first = await call('media', { paths: [clip], offset: 0, length: 50 * 1024 * 1024 });
  assert.equal(first.status, 200);
  assert.equal(Buffer.from((first.body as MediaBody).data, 'base64').length, MEDIA_CHUNK_BYTES);

  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < CLIP.length) {
    const res = await call('media', { paths: [clip], offset, length: MEDIA_CHUNK_BYTES });
    assert.equal(res.status, 200);
    const body = res.body as MediaBody;
    assert.equal(body.mediaType, 'video/mp4');
    assert.equal(body.size, CLIP.length);
    const part = Buffer.from(body.data, 'base64');
    parts.push(part);
    offset += part.length;
  }
  assert.equal(parts.length, 3);
  assert.equal(parts[2].length, CLIP.length - 2 * MEDIA_CHUNK_BYTES);
  assert.ok(Buffer.concat(parts).equals(CLIP));
});

test('media: 403 outside every root, 404 when missing or a directory', async () => {
  assert.equal((await call('media', { paths: ['/etc/hosts.png'] })).status, 403);
  assert.equal((await call('media', { paths: [path.join(root, 'nope.png')] })).status, 404);
  fs.mkdirSync(path.join(root, 'dir.png'));
  try {
    assert.equal((await call('media', { paths: [path.join(root, 'dir.png')] })).status, 404);
  } finally {
    fs.rmdirSync(path.join(root, 'dir.png'));
  }
});

test('media: 415 for an extension the browser cannot preview', async () => {
  assert.equal((await call('media', { paths: [path.join(root, 'binary.bin')] })).status, 415);
});

test('media: 413 over the size cap', async () => {
  // Sparse, so the oversized file costs no real disk.
  const big = path.join(root, 'big.mp4');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, MAX_MEDIA_BYTES + 1);
  try {
    assert.equal((await call('media', { paths: [big] })).status, 413);
  } finally {
    fs.rmSync(big);
  }
});

test('media: 400 for an offset outside the file', async () => {
  const pic = path.join(root, 'pic.png');
  assert.equal((await call('media', { paths: [pic], offset: -1 })).status, 400);
  assert.equal((await call('media', { paths: [pic], offset: PNG.length + 1 })).status, 400);
});

test('an unknown kind is refused rather than served', async () => {
  assert.equal((await handleFileRequest(ctx(), 'nope' as never, {}, OWNER_ACCESS)).status, 400);
});

test('sessionDiff: served for the owner, 404 for a session this machine lost', async () => {
  assert.equal((await call('sessionDiff', { sessionId: 'known' })).status, 200);
  assert.equal((await call('sessionDiff', { sessionId: 'gone' })).status, 404);
  // No session named at all is a client bug, not a request to serve.
  assert.equal((await call('sessionDiff', {})).status, 403);
});

test('sessionDiff: a session-scope grant cannot read a session outside it', async () => {
  // `readFiles` alone is not enough — this route returns contents from the
  // host's working tree, so the grant's session list is the real gate.
  const guest = { scope: 'session' as const, caps: OWNER_ACCESS.caps, sessionIds: ['other'] };
  assert.equal((await handleFileRequest(ctx(), 'sessionDiff', { sessionId: 'known' }, guest)).status, 403);
  const allowed = { ...guest, sessionIds: ['known'] };
  assert.equal((await handleFileRequest(ctx(), 'sessionDiff', { sessionId: 'known' }, allowed)).status, 200);
});

test('grep: searches file contents, all-or-nothing on roots', async () => {
  const res = await call('grep', { paths: [root], q: 'hi there' });
  assert.equal(res.status, 200);
  const files = (res.body as { files: { rel: string }[] }).files;
  assert.deepEqual(files.map((f) => f.rel), ['hello.txt']);
  assert.equal((await call('grep', { paths: [root, '/etc'], q: 'hi' })).status, 403);
  assert.equal((await call('grep', { paths: [], q: 'hi' })).status, 403);
});

test('grep and sessionSearch: an invalid regex is a 400', async () => {
  // The body is what tells this apart from the bare 400 an unknown kind gets.
  for (const kind of ['grep', 'sessionSearch'] as const) {
    const res = await call(kind, { paths: [root], q: '(', regex: true });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'invalidRegex' });
  }
});

/** Three sessions: two in the project, one elsewhere, each saying "needle". */
const SEARCH_SESSIONS: SessionMeta[] = [
  { id: 'inA', cwd: root, createdAt: 1, updatedAt: 10 },
  { id: 'inB', cwd: path.join(root, 'sub'), createdAt: 2, updatedAt: 20 },
  { id: 'away', cwd: '/elsewhere', createdAt: 3, updatedAt: 30 },
] as SessionMeta[];

function searchCtx(): UserContext {
  const base = ctx({
    list: () => SEARCH_SESSIONS,
    get: (id: string) => SEARCH_SESSIONS.find((s) => s.id === id),
  });
  return {
    ...base,
    store: {
      ...base.store,
      loadTranscript: (id: string) => [
        { seq: 1, ts: 1, kind: 'user', data: { text: `needle from ${id}` } },
      ],
    },
  } as unknown as UserContext;
}

const sessionIdsOf = (res: { body?: unknown }) =>
  (res.body as { sessions: { sessionId: string }[] }).sessions.map((s) => s.sessionId);

test('sessionSearch: the owner sees every session under the project, newest first', async () => {
  const res = await handleFileRequest(searchCtx(), 'sessionSearch', { paths: [root], q: 'needle' }, OWNER_ACCESS);
  assert.equal(res.status, 200);
  assert.deepEqual(sessionIdsOf(res), ['inB', 'inA']);
  assert.equal(
    (await handleFileRequest(searchCtx(), 'sessionSearch', { paths: ['/etc'], q: 'needle' }, OWNER_ACCESS))
      .status,
    403,
  );
});

test('sessionSearch: explicit sessionIds scope the search to exactly those', async () => {
  const res = await handleFileRequest(
    searchCtx(),
    'sessionSearch',
    { sessionIds: ['inA', 'missing'], q: 'needle' },
    OWNER_ACCESS,
  );
  assert.deepEqual(sessionIdsOf(res), ['inA']);
});

test('sessionSearch: a session-scope grant never reaches a session outside it', async () => {
  const guest = { scope: 'session' as const, caps: OWNER_ACCESS.caps, sessionIds: ['inA'] };
  const all = await handleFileRequest(searchCtx(), 'sessionSearch', { paths: [root], q: 'needle' }, guest);
  assert.deepEqual(sessionIdsOf(all), ['inA']);
  const asked = await handleFileRequest(
    searchCtx(),
    'sessionSearch',
    { sessionIds: ['inB', 'away'], q: 'needle' },
    guest,
  );
  assert.deepEqual(sessionIdsOf(asked), []);
});

test('sessionDiffFile: refuses a path outside the repo, and a repo outside the session', async () => {
  assert.equal(
    (await call('sessionDiffFile', { sessionId: 'known', paths: [root], rel: '../../etc/hosts' })).status,
    403,
  );
  // The repo resolves inside the workspace but is not one of this session's
  // commit units, so there is no baseline to diff against.
  assert.equal(
    (await call('sessionDiffFile', { sessionId: 'known', paths: [path.join(root, 'sub')], rel: 'x.txt' }))
      .status,
    404,
  );
});

// ---------------------------------------------------------------------------
// writeFile

const editDir = path.join(root, 'sub', 'edit');
fs.mkdirSync(editDir);
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-outside-'));
after(() => fs.rmSync(outside, { recursive: true, force: true }));

/** A fresh file per test, so no case sees another's write. */
function editable(name: string, content = 'before\n'): string {
  const p = path.join(editDir, name);
  fs.writeFileSync(p, content);
  return p;
}

/** Sibling temp files a write may have left behind. */
const leftovers = () => fs.readdirSync(editDir).filter((n) => n.includes('.lines-'));

test('writeFile: writes inside a root, returns the new mtime, and a later read sees it', async () => {
  const p = editable('w1.txt');
  const res = await call('writeFile', { paths: [p], content: 'after\n' });
  assert.equal(res.status, 200);
  const { mtimeMs } = res.body as { mtimeMs: number };
  assert.equal(mtimeMs, fs.statSync(p).mtimeMs);
  const read = await call('file', { paths: [p] });
  assert.deepEqual(read.body, { content: 'after\n', mtimeMs });
  assert.deepEqual(leftovers(), []);
});

test('writeFile: 403 outside every root and through a symlink that leaves it', async () => {
  const target = path.join(outside, 'secret.txt');
  fs.writeFileSync(target, 'untouched');
  assert.equal((await call('writeFile', { paths: [target], content: 'x' })).status, 403);
  // The link sits inside the project, so the prefix check alone would pass it.
  const link = path.join(editDir, 'escape.txt');
  fs.symlinkSync(target, link);
  assert.equal((await call('writeFile', { paths: [link], content: 'x' })).status, 403);
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
});

test('writeFile: a symlink inside the root is written through and stays a symlink', async () => {
  const target = editable('w-target.txt');
  const link = path.join(editDir, 'w-link.txt');
  fs.symlinkSync(target, link);
  assert.equal((await call('writeFile', { paths: [link], content: 'via link' })).status, 200);
  assert.equal(fs.readFileSync(target, 'utf8'), 'via link');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
});

test('writeFile: 404 when missing or a directory', async () => {
  assert.equal((await call('writeFile', { paths: [path.join(editDir, 'nope.txt')], content: 'x' })).status, 404);
  assert.equal((await call('writeFile', { paths: [path.join(root, 'sub')], content: 'x' })).status, 404);
});

test('writeFile: 400 without content, 413 over the cap, 415 on a NUL byte', async () => {
  const p = editable('w2.txt');
  assert.equal((await call('writeFile', { paths: [p] })).status, 400);
  const huge = 'a'.repeat(2 * 1024 * 1024 + 1);
  assert.equal((await call('writeFile', { paths: [p], content: huge })).status, 413);
  assert.equal((await call('writeFile', { paths: [p], content: 'a\0b' })).status, 415);
  assert.equal(fs.readFileSync(p, 'utf8'), 'before\n');
});

test('writeFile: 409 on a stale mtime leaves the file alone; no mtime writes anyway', async () => {
  const p = editable('w3.txt');
  const stale = fs.statSync(p).mtimeMs - 1000;
  const res = await call('writeFile', { paths: [p], content: 'mine', expectedMtimeMs: stale });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { mtimeMs: fs.statSync(p).mtimeMs });
  assert.equal(fs.readFileSync(p, 'utf8'), 'before\n');

  const current = fs.statSync(p).mtimeMs;
  assert.equal((await call('writeFile', { paths: [p], content: 'ok', expectedMtimeMs: current })).status, 200);
  assert.equal((await call('writeFile', { paths: [p], content: 'forced' })).status, 200);
  assert.equal(fs.readFileSync(p, 'utf8'), 'forced');
});

test('writeFile: preserves the file mode', async () => {
  const p = editable('w4.sh');
  fs.chmodSync(p, 0o755);
  assert.equal((await call('writeFile', { paths: [p], content: '#!/bin/sh\n' })).status, 200);
  assert.equal(fs.statSync(p).mode & 0o777, 0o755);
});

test('writeFile: a failed write removes its temp file and leaves the original', async () => {
  const p = editable('w5.txt');
  const rename = mock.method(fs, 'renameSync', () => {
    throw new Error('disk full');
  });
  try {
    assert.equal((await call('writeFile', { paths: [p], content: 'lost' })).status, 500);
  } finally {
    rename.mock.restore();
  }
  assert.equal(fs.readFileSync(p, 'utf8'), 'before\n');
  assert.deepEqual(leftovers(), []);
});
