import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { SessionDiffResponse, SessionMeta } from '@lines/shared';
import { OWNER_ACCESS } from '@lines/shared';
import { handleFileRequest } from './fileRoutes.ts';
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
  assert.deepEqual(res.body, { content: 'hi there' });
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
  assert.deepEqual(names, ['sub', '.hidden', 'binary.bin', 'hello.txt']); // dirs first, then alpha
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
