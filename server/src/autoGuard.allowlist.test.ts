import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { describeAllowEntry, normalizeAllowEntry, sameAllowEntry, type GuardAllowEntry } from '@lines/shared';
import { assessToolCall, GuardAllowlist } from './autoGuard.ts';
import { createStore } from './store.ts';

/** A fresh allowlist over a throwaway store, with allowlist writes counted. */
function harness(seed?: unknown[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-guard-'));
  const file = path.join(root, 'guard-allowlist.json');
  if (seed) fs.writeFileSync(file, JSON.stringify(seed));
  const store = createStore(root);
  let writes = 0;
  const save = store.saveGuardAllowlist;
  store.saveGuardAllowlist = (entries) => {
    writes++;
    save(entries);
  };
  const guard = new GuardAllowlist(store);
  const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8')) as GuardAllowEntry[];
  return { root, store, guard, onDisk, writes: () => writes };
}

/** The entry as the guard itself sees it — the only assertion that proves a row works. */
const allows = (command: string, entries: GuardAllowEntry[]) =>
  !assessToolCall('Bash', { command }, ['/tmp'], entries).dangerous;

test('a hand-typed prefix is whitespace-collapsed into one the guard can match', () => {
  const result = normalizeAllowEntry({ tool: 'Bash', prefix: '  git   status  ' });
  assert.deepEqual(result, { entry: { tool: 'Bash', prefix: 'git status' } });
  // Asserted through assessToolCall, not on the string: the collapse only matters
  // because segmentAllowed compares against split-and-trimmed command segments.
  assert.equal(allows('git status --short', [{ tool: 'Bash', prefix: 'git status' }]), true);
});

test('a longer prefix stays intact and stays narrower', () => {
  const result = normalizeAllowEntry({ tool: 'Bash', prefix: 'npm run build' });
  assert.deepEqual(result, { entry: { tool: 'Bash', prefix: 'npm run build' } });
  const entries = [{ tool: 'Bash', prefix: 'npm run build' }];
  assert.equal(allows('npm run build --watch', entries), true);
  assert.equal(allows('npm install left-pad', entries), false);
});

test('tools that always ask can never be allowlisted', () => {
  assert.deepEqual(normalizeAllowEntry({ tool: 'AskUserQuestion' }), { error: 'always-ask' });
  assert.deepEqual(normalizeAllowEntry({ tool: 'ExitPlanMode' }), { error: 'always-ask' });
});

test('a Bash entry without a usable prefix is refused', () => {
  assert.deepEqual(normalizeAllowEntry({ tool: 'Bash' }), { error: 'bash-needs-prefix' });
  assert.deepEqual(normalizeAllowEntry({ tool: 'Bash', prefix: '   ' }), { error: 'bash-needs-prefix' });
});

test('a chained prefix is refused — the guard splits commands on those operators', () => {
  assert.deepEqual(normalizeAllowEntry({ tool: 'Bash', prefix: 'npm run && rm -rf' }), {
    error: 'prefix-chained',
  });
});

test('a non-Bash entry drops its prefix into the shape the guard compares', () => {
  const result = normalizeAllowEntry({ tool: 'WebFetch', prefix: 'ignored' });
  assert.deepEqual(result, { entry: { tool: 'WebFetch' } });
  assert.equal(
    assessToolCall('SomeMcpWrite', {}, ['/tmp'], [{ tool: 'SomeMcpWrite' }]).dangerous,
    false,
  );
});

test('add persists, and a second identical add is a no-op duplicate', () => {
  const h = harness();
  assert.deepEqual(h.guard.add({ tool: 'Bash', prefix: 'npm run' }), { ok: true });
  assert.deepEqual(h.onDisk(), [{ tool: 'Bash', prefix: 'npm run' }]);
  assert.equal(h.writes(), 1);
  assert.deepEqual(h.guard.add({ tool: 'Bash', prefix: 'npm run' }), {
    ok: false,
    reason: 'duplicate',
  });
  assert.equal(h.writes(), 1);
});

test('add refuses an invalid entry with the validator reason', () => {
  const h = harness();
  assert.deepEqual(h.guard.add({ tool: 'ExitPlanMode' }), { ok: false, reason: 'always-ask' });
  assert.equal(h.writes(), 0);
});

test('remove drops only the matching entry and persists', () => {
  const h = harness();
  h.guard.add({ tool: 'Bash', prefix: 'npm run' });
  h.guard.add({ tool: 'Bash', prefix: 'git status' });
  assert.equal(h.guard.remove({ tool: 'Bash', prefix: 'npm run' }), true);
  assert.deepEqual(h.onDisk(), [{ tool: 'Bash', prefix: 'git status' }]);
  assert.equal(h.guard.remove({ tool: 'Bash', prefix: 'npm run' }), false);
});

test('load migrates away junk, inert and near-duplicate entries, rewriting once', () => {
  const h = harness([
    { tool: 'Bash', prefix: '' },
    { tool: 'AskUserQuestion' },
    { tool: 'Bash', prefix: 'npm  run' },
    { tool: 'Bash', prefix: 'npm run' },
  ]);
  assert.deepEqual(h.guard.list(), [{ tool: 'Bash', prefix: 'npm run' }]);
  assert.equal(h.writes(), 1);
  assert.deepEqual(h.onDisk(), [{ tool: 'Bash', prefix: 'npm run' }]);
});

test('the migration is idempotent — an already-clean file is not rewritten', () => {
  const h = harness([{ tool: 'Bash', prefix: 'npm run' }, { tool: 'WebFetch' }]);
  assert.equal(h.writes(), 0);
});

test('a second instance over the same root sees what the first added', () => {
  const h = harness();
  h.guard.add({ tool: 'Bash', prefix: 'npm run' });
  const reloaded = new GuardAllowlist(createStore(h.root));
  assert.deepEqual(reloaded.list(), [{ tool: 'Bash', prefix: 'npm run' }]);
});

test('acceptReview drops an always-ask entry arriving via a pending blob', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-guard-accept-'));
  // A staged review round-trips through disk unvalidated, so it can hold an entry
  // the guard would never match — accepting it must not install one.
  fs.writeFileSync(
    path.join(root, 'guard-allowlist-sync.json'),
    JSON.stringify({
      updatedAt: 1,
      pending: {
        entries: [{ tool: 'ExitPlanMode' }, { tool: 'Bash', prefix: 'npm  run' }],
        remoteUpdatedAt: 2,
        detectedAt: 3,
      },
      rejected: null,
    }),
  );
  const guard = new GuardAllowlist(createStore(root));
  assert.equal(guard.acceptReview(), true);
  assert.deepEqual(guard.list(), [{ tool: 'Bash', prefix: 'npm run' }]);
});

test('a plan-read scope survives normalization on Bash only, and keeps entries apart', () => {
  assert.deepEqual(normalizeAllowEntry({ tool: 'Bash', prefix: 'node  -e', scope: 'plan-read' }), {
    entry: { tool: 'Bash', prefix: 'node -e', scope: 'plan-read' },
  });
  assert.deepEqual(normalizeAllowEntry({ tool: 'Bash', prefix: 'node -e', scope: 'other' }), {
    entry: { tool: 'Bash', prefix: 'node -e' },
  });
  assert.deepEqual(normalizeAllowEntry({ tool: 'WebFetch', scope: 'plan-read' }), { entry: { tool: 'WebFetch' } });
  const read: GuardAllowEntry = { tool: 'Bash', prefix: 'node -e', scope: 'plan-read' };
  assert.equal(sameAllowEntry(read, { tool: 'Bash', prefix: 'node -e' }), false);
  assert.equal(describeAllowEntry(read), 'Bash: node -e (plan-mode read)');
});
