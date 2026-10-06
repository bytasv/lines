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
    model: 'claude-opus-5-5',
    permissionMode: 'auto',
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
  return harnessWithCard({ requestId: 'r1', toolName, input });
}

/** The same, with the recorded card spelled out — for a card that carries `alwaysAllowEntry`. */
function harnessWithCard(card: Record<string, unknown>) {
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
      data: card,
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

test('always-allow on a chained command allowlists the command the guard flagged', () => {
  // Not the leading `cd app`, which was never the reason for the card: the entry
  // is the one that exempts the flagged command next time.
  const h = harness('Bash', { command: 'cd app && git push --force origin main' });
  h.sessions.resolvePermission('s1', 'r1', true, undefined, undefined, undefined, true);
  assert.deepEqual(h.guard.list(), [{ tool: 'Bash', prefix: 'git push' }]);
  assert.equal(h.changes.length, 1);
  assert.equal(h.writes(), 1);
});

test('always-allow saves nothing for a command that cannot be allowlisted', () => {
  // `rm -rf` is a rule match on its own: an entry for it would disarm the rule.
  const h = harness('Bash', { command: 'npm run build && rm -rf dist' });
  h.sessions.resolvePermission('s1', 'r1', true, undefined, undefined, undefined, true);
  assert.deepEqual(h.guard.list(), []);
  assert.equal(h.writes(), 0);
});

test('always-allow saves exactly what the card recorded, not a re-derivation', () => {
  // A card that said "this cannot be allowlisted" stays that way at the click.
  const refused = harnessWithCard({
    requestId: 'r1',
    toolName: 'Bash',
    input: { command: 'git push --force' },
    alwaysAllowEntry: null,
  });
  refused.sessions.resolvePermission('s1', 'r1', true, undefined, undefined, undefined, true);
  assert.deepEqual(refused.guard.list(), []);

  // A card from before the field existed is derived the same way, at the click.
  const legacy = harness('Bash', { command: 'git push --force' });
  legacy.sessions.resolvePermission('s1', 'r1', true, undefined, undefined, undefined, true);
  assert.deepEqual(legacy.guard.list(), [{ tool: 'Bash', prefix: 'git push' }]);
});

test('a second always-allow for the same pattern does not rewrite the file', () => {
  const h = harness('Bash', { command: 'git push --force' });
  h.sessions.resolvePermission('s1', 'r1', true, undefined, undefined, undefined, true);
  h.sessions.resolvePermission('s1', 'r1', true, undefined, undefined, undefined, true);
  assert.equal(h.guard.list().length, 1);
  assert.equal(h.writes(), 1);
  assert.equal(h.changes.length, 1);
});

test('denying with always-allow set writes nothing', () => {
  const h = harness('Bash', { command: 'git push --force' });
  h.sessions.resolvePermission('s1', 'r1', false, undefined, undefined, 'no', true);
  assert.deepEqual(h.guard.list(), []);
  assert.equal(h.writes(), 0);
});
