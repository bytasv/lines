import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { McpConnection, SessionMeta, TranscriptEvent } from '@lines/shared';
import { createStore } from './store.ts';

/** Fixed mtime, restored after an out-of-band write so the cache's stat check
 *  sees an unchanged file. Whole seconds — utimes round-trips those exactly. */
const STAMP = new Date(1_700_000_000_000);

function tmpStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-store-'));
  return { root, store: createStore(root), file: (id: string) => path.join(root, 'transcripts', `${id}.jsonl`) };
}

const ev = (seq: number): TranscriptEvent => ({ seq, ts: 0, kind: 'user', data: { text: `m${seq}` } }) as TranscriptEvent;

test('transcript reads are served from cache while mtime and size match', () => {
  const { store, file } = tmpStore();
  const f = file('s1');
  store.appendTranscript('s1', ev(0));
  fs.utimesSync(f, STAMP, STAMP);
  assert.equal(store.loadTranscript('s1')[0].seq, 0);

  // Same size, same mtime — the cached lines win even though the bytes changed.
  fs.writeFileSync(f, `${JSON.stringify(ev(9))}\n`);
  fs.utimesSync(f, STAMP, STAMP);
  assert.equal(store.loadTranscript('s1')[0].seq, 0);
});

test('a write with a different size is picked up', () => {
  const { store, file } = tmpStore();
  store.appendTranscript('s1', ev(0));
  store.loadTranscript('s1');
  fs.writeFileSync(file('s1'), `${JSON.stringify(ev(0))}\n${JSON.stringify(ev(1))}\n`);
  assert.deepEqual(
    store.loadTranscript('s1').map((e) => e.seq),
    [0, 1],
  );
});

test('appendTranscript extends the cached entry instead of invalidating it', () => {
  const { store } = tmpStore();
  store.appendTranscript('s1', ev(0));
  assert.equal(store.loadTranscript('s1').length, 1); // populates `parsed`
  store.appendTranscript('s1', ev(1));
  assert.deepEqual(
    store.loadTranscript('s1').map((e) => e.seq),
    [0, 1],
  );
  assert.deepEqual(store.loadTranscriptRaw('s1').length, 2);
});

test('deleteTranscript drops the cache entry', () => {
  const { store } = tmpStore();
  store.appendTranscript('s1', ev(0));
  store.loadTranscript('s1');
  store.deleteTranscript('s1');
  assert.deepEqual(store.loadTranscript('s1'), []);
  assert.deepEqual(store.loadTranscriptRaw('s1'), []);
});

test('a torn trailing line is dropped from both the raw and parsed views', () => {
  const { store, file } = tmpStore();
  fs.writeFileSync(file('s1'), `${JSON.stringify(ev(0))}\n${JSON.stringify(ev(1)).slice(0, 12)}`);
  assert.deepEqual(store.loadTranscriptRaw('s1'), [JSON.stringify(ev(0))]);
  assert.deepEqual(
    store.loadTranscript('s1').map((e) => e.seq),
    [0],
  );
});

test('raw lines join into a parseable events array', () => {
  const { store } = tmpStore();
  store.appendTranscript('s1', ev(0));
  store.appendTranscript('s1', ev(1));
  const events = JSON.parse(`[${store.loadTranscriptRaw('s1').join(',')}]`) as TranscriptEvent[];
  assert.deepEqual(
    events.map((e) => e.seq),
    [0, 1],
  );
});

test('the cache is bounded — old sessions are evicted, not accumulated', () => {
  const { store, file } = tmpStore();
  for (let i = 0; i < 20; i++) store.appendTranscript(`s${i}`, ev(0));
  for (let i = 0; i < 20; i++) {
    fs.utimesSync(file(`s${i}`), STAMP, STAMP);
    store.loadTranscript(`s${i}`);
  }
  // s0 fell out of the bound: an edit it would otherwise have masked is visible.
  const evicted = file('s0');
  fs.writeFileSync(evicted, `${JSON.stringify(ev(7))}\n`);
  fs.utimesSync(evicted, STAMP, STAMP);
  assert.equal(store.loadTranscript('s0')[0].seq, 7);
  // The most recent one is still cached, so the same edit is masked there.
  const kept = file('s19');
  fs.writeFileSync(kept, `${JSON.stringify(ev(7))}\n`);
  fs.utimesSync(kept, STAMP, STAMP);
  assert.equal(store.loadTranscript('s19')[0].seq, 0);
});

test('guard sync state round-trips, and a missing file reads as empty', () => {
  const { store } = tmpStore();
  assert.deepEqual(store.loadGuardSync(), { updatedAt: 0, pending: null, rejected: null });
  const state = {
    updatedAt: 7,
    pending: { entries: [{ tool: 'Bash', prefix: 'npm run' }], remoteUpdatedAt: 3, detectedAt: 5 },
    rejected: { entries: [{ tool: 'WebFetch' }], rejectedAt: 6 },
  };
  store.saveGuardSync(state);
  assert.deepEqual(store.loadGuardSync(), state);
});

test('MCP connections and their sync state round-trip, missing files read as empty', () => {
  const { store } = tmpStore();
  assert.deepEqual(store.loadMcpConnections<unknown[]>([]), []);
  assert.deepEqual(store.loadMcpSync(), { updatedAt: 0, pending: null, rejected: null });
  const connections: McpConnection[] = [
    { id: 'a', name: 'figma', transport: 'http', url: 'https://x.example/mcp', enabled: true },
  ];
  store.saveMcpConnections(connections);
  assert.deepEqual(store.loadMcpConnections<unknown[]>([]), connections);
  const state = {
    updatedAt: 7,
    pending: { connections, remoteUpdatedAt: 3, detectedAt: 5 },
    rejected: { connections: [], rejectedAt: 6 },
  };
  store.saveMcpSync(state);
  assert.deepEqual(store.loadMcpSync(), state);
});

test('MCP secrets round-trip, are 0600, and stay out of the connections file', () => {
  const { root, store } = tmpStore();
  assert.deepEqual(store.loadMcpSecrets(), {});
  store.saveMcpConnections([
    { id: 'a', name: 'figma', transport: 'http', url: 'https://x.example/mcp', enabled: true },
  ]);
  store.saveMcpSecrets({ a: { Authorization: 'Bearer secret-token' } });
  assert.deepEqual(store.loadMcpSecrets(), { a: { Authorization: 'Bearer secret-token' } });
  // The synced file must never carry a value.
  assert.equal(
    fs.readFileSync(path.join(root, 'mcp-connections.json'), 'utf8').includes('secret-token'),
    false,
  );
  const mode = fs.statSync(path.join(root, 'mcp-secrets.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('a non-string secret value is dropped rather than handed to the SDK', () => {
  const { root, store } = tmpStore();
  fs.writeFileSync(
    path.join(root, 'mcp-secrets.json'),
    JSON.stringify({ a: { Good: 'v', Bad: 42 }, b: 'not-an-object' }),
  );
  assert.deepEqual(store.loadMcpSecrets(), { a: { Good: 'v' } });
});

/** projects.json is sanitized on every read; these write the file directly to get
 *  the untrusted forms a real disk can hold. */
function projectsFile(raw: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-projects-'));
  const file = path.join(root, 'projects.json');
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  return { file, load: () => createStore(root).loadProjects(), bytes: () => fs.readFileSync(file, 'utf8') };
}

test('a worktree record is kept only when its path is a usable string', () => {
  const { load } = projectsFile([
    {
      path: '/repo',
      worktrees: [
        { path: '/wt/keep', branch: 'b' },
        { path: 42 },
        { path: '   ' },
        { branch: 'no path' },
        'not an object',
      ],
    },
  ]);
  assert.deepEqual(load()[0].worktrees, [{ path: '/wt/keep', branch: 'b' }]);
});

test('worktree paths are normalized and deduped, as roots are', () => {
  const { load } = projectsFile([
    { path: '/repo', worktrees: [{ path: '/wt/x/' }, { path: '/wt/x' }] },
  ]);
  assert.deepEqual(load()[0].worktrees, [{ path: '/wt/x' }]);
});

test('a worktree equal to the primary or to an extra root is dropped', () => {
  const { load } = projectsFile([
    {
      path: '/repo',
      extraRoots: ['/docs'],
      // Either would make one directory answer to two notions at once.
      worktrees: [{ path: '/repo' }, { path: '/docs' }, { path: '/wt/x' }],
    },
  ]);
  assert.deepEqual(load()[0].worktrees, [{ path: '/wt/x' }]);
});

test('only correctly typed optional fields survive a worktree record', () => {
  const { load } = projectsFile([
    {
      path: '/repo',
      worktrees: [
        {
          path: '/wt/x',
          branch: '',
          baseRef: 7,
          createdAt: 'yesterday',
          sessionId: 's1',
          createdByLines: 'yes',
        },
      ],
    },
  ]);
  assert.deepEqual(load()[0].worktrees, [{ path: '/wt/x', sessionId: 's1' }]);
});

test('a non-array worktrees field is ignored rather than repaired', () => {
  const { load } = projectsFile([{ path: '/repo', worktrees: 'nope' }]);
  assert.equal('worktrees' in load()[0], false);
});

test('legacy and pre-worktree forms round-trip without gaining a worktrees key', () => {
  assert.deepEqual(projectsFile(['/repo', '/other']).load(), [{ path: '/repo' }, { path: '/other' }]);
  const objects = projectsFile([{ path: '/repo', extraRoots: ['/docs'] }]).load();
  assert.deepEqual(objects, [{ path: '/repo', extraRoots: ['/docs'] }]);
  assert.equal('worktrees' in objects[0], false);
});

/** The one-shot migration only rewrites when the sanitized form differs, so an
 *  existing file that never had worktrees must stay byte-identical. */
test('a project without worktrees is left untouched on load', () => {
  const canonical = [{ path: '/repo', extraRoots: ['/docs'] }];
  const p = projectsFile(canonical);
  const before = p.bytes();
  p.load();
  assert.equal(p.bytes(), before);
});

test('sessions.json is written compactly', () => {
  const { store, root } = tmpStore();
  const meta = {
    id: 'a',
    name: 'n',
    cwd: '/tmp',
    model: 'claude-opus-5',
    permissionMode: 'default',
    status: 'idle',
    createdAt: 1,
  } as SessionMeta;
  store.saveSessions([meta]);
  assert.equal(fs.readFileSync(path.join(root, 'sessions.json'), 'utf8').includes('\n'), false);
});

// ---------------------------------------------------------------------------
// truncateTranscript (session rewind)
// ---------------------------------------------------------------------------

test('truncateTranscript keeps everything before the cut and reports what went', () => {
  const { store } = tmpStore();
  for (const seq of [0, 1, 2, 3]) store.appendTranscript('s1', ev(seq));
  assert.equal(store.truncateTranscript('s1', 2), 2);
  assert.deepEqual(
    store.loadTranscript('s1').map((e) => e.seq),
    [0, 1],
  );
});

test('the dropped lines are archived to a rewind sidecar', () => {
  const { store, root } = tmpStore();
  for (const seq of [0, 1, 2]) store.appendTranscript('s1', ev(seq));
  store.truncateTranscript('s1', 1);
  const dir = path.join(root, 'transcripts');
  const sidecar = fs.readdirSync(dir).find((f) => f.startsWith('s1.rewind-'));
  assert.ok(sidecar, 'a sidecar must be written');
  const archived = fs
    .readFileSync(path.join(dir, sidecar!), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as TranscriptEvent).seq);
  assert.deepEqual(archived, [1, 2]);
});

/** `loadTranscript` hands out `entry.parsed` by reference, so a truncation that
 *  trimmed the cache in place would mutate an array a live reader still holds. */
test('a truncation invalidates the cache instead of mutating a shared array', () => {
  const { store } = tmpStore();
  for (const seq of [0, 1, 2]) store.appendTranscript('s1', ev(seq));
  const held = store.loadTranscript('s1');
  store.truncateTranscript('s1', 1);
  assert.equal(held.length, 3, "a reader's array must not be trimmed under it");
  assert.equal(store.loadTranscript('s1').length, 1);
  assert.notEqual(store.loadTranscript('s1'), held);
});

test('a seq past the end truncates nothing', () => {
  const { store } = tmpStore();
  store.appendTranscript('s1', ev(0));
  assert.equal(store.truncateTranscript('s1', 5), 0);
  assert.equal(store.loadTranscript('s1').length, 1);
});

test('appends after a truncation land on the truncated file', () => {
  const { store } = tmpStore();
  for (const seq of [0, 1, 2]) store.appendTranscript('s1', ev(seq));
  store.truncateTranscript('s1', 1);
  store.appendTranscript('s1', ev(1));
  assert.deepEqual(
    store.loadTranscript('s1').map((e) => e.seq),
    [0, 1],
  );
});

test('deleting a session takes its rewind sidecars with it', () => {
  const { store, root } = tmpStore();
  for (const seq of [0, 1]) store.appendTranscript('s1', ev(seq));
  store.truncateTranscript('s1', 1);
  store.deleteTranscript('s1');
  assert.deepEqual(
    fs.readdirSync(path.join(root, 'transcripts')).filter((f) => f.startsWith('s1')),
    [],
  );
});
