import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { SessionMeta } from '@lines/shared';
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

/** Only the members the routes actually read. */
function ctx(): UserContext {
  return {
    store: { loadProjects: () => [{ path: root }], attachmentsRoot: attachments },
    sessions: { list: () => [] as SessionMeta[] },
  } as unknown as UserContext;
}

const call = (kind: Parameters<typeof handleFileRequest>[1], params = {}) =>
  handleFileRequest(ctx(), kind, params);

test('file: reads a file inside a project root', () => {
  const res = call('file', { paths: [path.join(root, 'hello.txt')] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { content: 'hi there' });
});

test('file: 403 outside every root, 404 when missing', () => {
  assert.equal(call('file', { paths: ['/etc/hosts'] }).status, 403);
  assert.equal(call('file', { paths: [path.join(root, 'nope.txt')] }).status, 404);
  // A directory is not a file.
  assert.equal(call('file', { paths: [path.join(root, 'sub')] }).status, 404);
});

test('file: 415 on binary content', () => {
  // NUL in the first 8KB — the same probe the HTTP route used.
  assert.equal(call('file', { paths: [path.join(root, 'binary.bin')] }).status, 415);
});

test('file: a missing path is 403, not a crash', () => {
  assert.equal(call('file', {}).status, 403);
});

test('tree: lists entries, hiding dotfiles and node_modules', () => {
  const res = call('tree', { paths: [root] });
  assert.equal(res.status, 200);
  const names = (res.body as { entries: { name: string }[] }).entries.map((e) => e.name);
  assert.deepEqual(names, ['sub', 'binary.bin', 'hello.txt']); // dirs first, then alpha
  assert.ok(!names.includes('node_modules'));
  assert.ok(!names.includes('.hidden'));
});

test('tree: 403 outside every root', () => {
  assert.equal(call('tree', { paths: ['/etc'] }).status, 403);
});

test('find: searches across roots', () => {
  const res = call('find', { paths: [root], q: 'hello' });
  assert.equal(res.status, 200);
  const files = (res.body as { files: { rel: string }[] }).files;
  assert.ok(files.some((f) => f.rel === 'hello.txt'));
});

test('find: one bad root fails the whole request', () => {
  // All-or-nothing on purpose: a partial result reads as "no match here" and
  // would silently hide a whole folder from the mention list.
  assert.equal(call('find', { paths: [root, '/etc'], q: 'hello' }).status, 403);
  assert.equal(call('find', { paths: [], q: 'hello' }).status, 403);
});

test('find: limit is capped regardless of what the client asks for', () => {
  const res = call('find', { paths: [root], q: '', limit: 10_000 });
  assert.equal(res.status, 200);
  assert.ok((res.body as { files: unknown[] }).files.length <= 25);
});

test('attachment: returns base64 plus a media type', () => {
  const res = call('attachment', { rel: 'pic.png' });
  assert.equal(res.status, 200);
  const body = res.body as { data: string; mediaType: string };
  assert.equal(body.mediaType, 'image/png');
  assert.deepEqual([...Buffer.from(body.data, 'base64')], [0x89, 0x50, 0x4e, 0x47]);
});

test('attachment: path traversal is refused', () => {
  // The attachments root is the only thing this route may read, so escaping it
  // must fail even though the target exists and is readable.
  assert.equal(call('attachment', { rel: '../../etc/hosts' }).status, 403);
  assert.equal(call('attachment', { rel: 'missing.png' }).status, 404);
});

test('an unknown kind is refused rather than served', () => {
  assert.equal(handleFileRequest(ctx(), 'nope' as never, {}).status, 400);
});
