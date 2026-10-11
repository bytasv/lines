import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SessionMeta } from '@lines/shared';
import type { WorkerClient } from './workerClient.ts';

// Read once at import, as the bridge does, so it is set before the module loads.
const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-shared-'));
process.env.LINES_SHARED_ROOT = shared;
const { buildUserContext, READ_ONLY_SESSION } = await import('./userContext.ts');

const meta = (id: string): SessionMeta =>
  ({ id, name: id, cwd: '/tmp', model: 'claude-opus-5-5', permissionMode: 'default', status: 'idle', createdAt: 1, updatedAt: 5 }) as SessionMeta;

function devContext() {
  const sharedUser = path.join(shared, 'users', 'u1');
  fs.mkdirSync(path.join(sharedUser, 'transcripts'), { recursive: true });
  fs.writeFileSync(
    path.join(sharedUser, 'transcripts', 'p1.jsonl'),
    JSON.stringify({ seq: 0, ts: 0, kind: 'user', data: { text: 'from prod' } }) + '\n',
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-dev-'));
  const ctx = buildUserContext('u1', root, {
    push: () => {},
    interrupt: () => {},
    stopTask: () => {},
    close: () => {},
  } as unknown as WorkerClient);
  const pushed: string[] = [];
  ctx.sync.pushSession = (m: SessionMeta) => void pushed.push(m.id);
  return { ctx, root, pushed };
}

test('a session pulled from storage is read only, with its transcript read from the shared root', () => {
  const { ctx } = devContext();
  ctx.sync.applying = true;
  ctx.sessions.adoptSynced(meta('p1'));
  ctx.sync.applying = false;
  assert.equal(ctx.lockReason('p1'), READ_ONLY_SESSION);
  assert.equal(ctx.presentSession(ctx.sessions.get('p1')!).readOnly, true);
  assert.equal(ctx.sessions.get('p1')!.readOnly, undefined, 'the flag is never stored');
  assert.deepEqual(ctx.store.loadTranscript('p1').map((e) => e.seq), [0]);
});

test('a session first seen outside a pull is this bridge’s own and never pushed', () => {
  const { ctx, root, pushed } = devContext();
  ctx.sessions.adoptSynced(meta('d1'));
  assert.equal(ctx.lockReason('d1'), null);
  assert.equal(ctx.presentSession(ctx.sessions.get('d1')!).readOnly, undefined);
  assert.deepEqual(pushed, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'dev-sessions.json'), 'utf8')), ['d1']);
});
