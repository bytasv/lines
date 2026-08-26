import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { GuardAllowEntry, SessionMeta } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';

const meta = (): SessionMeta =>
  ({
    id: 's1',
    name: 's1',
    cwd: '/tmp',
    model: 'claude-opus-5',
    permissionMode: 'auto',
    caveman: { enabled: false, level: 'full' },
    status: 'idle',
    createdAt: 1,
  }) as SessionMeta;

/**
 * A manager whose session has one unresolved permission request in its transcript
 * — which is all resolvePermission's `alwaysAllow` branch reads. The query itself
 * is gone, so the decision takes the recovery path; the allowlist write happens
 * first either way.
 */
function harness(toolName: string, input: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-always-allow-'));
  // createStore first: it is what creates the transcripts/ directory seeded below.
  const store = createStore(root);
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta()]));
  fs.writeFileSync(
    path.join(root, 'transcripts', 's1.jsonl'),
    JSON.stringify({
      seq: 0,
      ts: 0,
      kind: 'permission',
      data: { requestId: 'r1', toolName, input },
    }) + '\n',
  );
  let writes = 0;
  const save = store.saveGuardAllowlist;
  store.saveGuardAllowlist = (entries) => {
    writes++;
    save(entries);
  };
  const guard = new GuardAllowlist(store);
  const changes: GuardAllowEntry[][] = [];
  guard.onChange = (entries) => changes.push(entries);
  const sessions = new SessionManager(store, guard, () => {});
  sessions.attachWorker({ push: () => {}, interrupt: () => {}, close: () => {} } as never);
  return { sessions, guard, changes, writes: () => writes };
}

test('always-allow on a chained command allowlists only the leading prefix', () => {
  const h = harness('Bash', { command: 'npm run build && rm -rf dist' });
  h.sessions.resolvePermission('s1', 'r1', true, undefined, undefined, undefined, true);
  assert.deepEqual(h.guard.list(), [{ tool: 'Bash', prefix: 'npm run' }]);
  assert.equal(h.changes.length, 1);
  assert.equal(h.writes(), 1);
});

test('a second always-allow for the same pattern does not rewrite the file', () => {
  const h = harness('Bash', { command: 'npm run build' });
  h.sessions.resolvePermission('s1', 'r1', true, undefined, undefined, undefined, true);
  h.sessions.resolvePermission('s1', 'r1', true, undefined, undefined, undefined, true);
  assert.equal(h.guard.list().length, 1);
  assert.equal(h.writes(), 1);
  assert.equal(h.changes.length, 1);
});

test('denying with always-allow set writes nothing', () => {
  const h = harness('Bash', { command: 'npm run build' });
  h.sessions.resolvePermission('s1', 'r1', false, undefined, undefined, 'no', true);
  assert.deepEqual(h.guard.list(), []);
  assert.equal(h.writes(), 0);
});
