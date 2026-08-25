import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FilesChangedData, TranscriptEvent } from '@lines/shared';
import { collectChangedPaths } from './sessions.ts';

/**
 * Attribution for the session review diff: which changed files this session is
 * known to have made. Diff *content* always comes from git — this only decides
 * which bucket a path lands in.
 */

const ROOT = '/repo';
let seq = 0;
const reset = () => {
  seq = 0;
};

function filesChanged(data: FilesChangedData): TranscriptEvent {
  return { seq: ++seq, ts: seq, kind: 'files-changed', data };
}

function toolUse(name: string, filePath: string, subagent = false): TranscriptEvent {
  return {
    seq: ++seq,
    ts: seq,
    kind: 'sdk',
    data: {
      type: 'assistant',
      ...(subagent ? { parent_tool_use_id: 'toolu_parent' } : {}),
      message: { content: [{ type: 'tool_use', id: `t${seq}`, name, input: { file_path: filePath } }] },
    },
  };
}

test('a files-changed window is the authoritative source', () => {
  reset();
  const events = [
    filesChanged({ resultSeq: 1, repos: [{ repo: ROOT, rels: ['a.ts', 'sub/b.ts'] }] }),
  ];
  const { paths, ambiguous } = collectChangedPaths(events, [ROOT]);
  assert.deepEqual(paths.sort(), ['/repo/a.ts', '/repo/sub/b.ts']);
  assert.deepEqual(ambiguous, []);
});

test('a path only a window saw — the shell or MCP case — is still attributed', () => {
  reset();
  // `echo x >> a.txt` makes no tool_use with a file_path, so the window is the
  // only thing that knows about it.
  const events = [filesChanged({ resultSeq: 1, repos: [{ repo: ROOT, rels: ['a.txt'] }] })];
  assert.deepEqual(collectChangedPaths(events, [ROOT]).paths, ['/repo/a.txt']);
});

test('file-tool calls are a backstop when a turn left no window', () => {
  reset();
  const events = [toolUse('Write', '/repo/x.ts'), toolUse('Edit', '/repo/y.ts')];
  assert.deepEqual(collectChangedPaths(events, [ROOT]).paths.sort(), ['/repo/x.ts', '/repo/y.ts']);
});

test('subagent writes count, unlike scanTurnActivity', () => {
  reset();
  // A Task subagent edits files on this session's behalf, in its working tree.
  const events = [toolUse('Write', '/repo/sub.ts', true)];
  assert.deepEqual(collectChangedPaths(events, [ROOT]).paths, ['/repo/sub.ts']);
});

test('non-write tools and non-assistant messages are ignored', () => {
  reset();
  const events = [
    toolUse('Read', '/repo/read-only.ts'),
    toolUse('Grep', '/repo/searched.ts'),
    { seq: ++seq, ts: seq, kind: 'user', data: { text: 'hi' } } as TranscriptEvent,
  ];
  assert.deepEqual(collectChangedPaths(events, [ROOT]).paths, []);
});

test('a relative file_path resolves against the primary root', () => {
  reset();
  assert.deepEqual(collectChangedPaths([toolUse('Write', 'rel.ts')], [ROOT]).paths, ['/repo/rel.ts']);
});

test('the two sources are unioned, with duplicates collapsed', () => {
  reset();
  const events = [
    filesChanged({ resultSeq: 1, repos: [{ repo: ROOT, rels: ['a.ts'] }] }),
    toolUse('Write', '/repo/a.ts'),
    toolUse('Write', '/repo/b.ts'),
  ];
  assert.deepEqual(collectChangedPaths(events, [ROOT]).paths.sort(), ['/repo/a.ts', '/repo/b.ts']);
});

test('an overlapped window reports its paths as unclear rather than claiming them', () => {
  reset();
  const events = [
    filesChanged({ resultSeq: 1, repos: [{ repo: ROOT, rels: ['theirs.ts'], ambiguous: true }] }),
  ];
  const { paths, ambiguous } = collectChangedPaths(events, [ROOT]);
  assert.deepEqual(paths, []);
  assert.deepEqual(ambiguous, ['/repo/theirs.ts']);
});

test('a tool call outranks an overlapped window for the same path', () => {
  reset();
  // Direct evidence that this session wrote the file beats the window's doubt.
  const events = [
    filesChanged({ resultSeq: 1, repos: [{ repo: ROOT, rels: ['mine.ts'], ambiguous: true }] }),
    toolUse('Write', '/repo/mine.ts'),
  ];
  const { paths, ambiguous } = collectChangedPaths(events, [ROOT]);
  assert.deepEqual(paths, ['/repo/mine.ts']);
  assert.deepEqual(ambiguous, []);
});

test('multi-repo windows resolve each path against its own repo', () => {
  reset();
  const events = [
    filesChanged({
      resultSeq: 1,
      repos: [
        { repo: '/one', rels: ['a.ts'] },
        { repo: '/two', rels: ['a.ts'] },
      ],
    }),
  ];
  assert.deepEqual(collectChangedPaths(events, ['/one', '/two']).paths.sort(), ['/one/a.ts', '/two/a.ts']);
});
