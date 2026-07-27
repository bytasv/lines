import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TranscriptEvent } from '@lines/shared';
import { collectTurns, findStepStart, unresolvedPermissionIds } from './sessions.ts';

let seq = 0;
const ev = (kind: TranscriptEvent['kind'], data: unknown): TranscriptEvent =>
  ({ seq: ++seq, ts: 0, kind, data }) as TranscriptEvent;

const user = (text: string) => ev('user', { text });
const assistant = (...content: unknown[]) => ev('sdk', { type: 'assistant', message: { content } });
const text = (t: string) => ({ type: 'text', text: t });
const tool = (name: string, input: unknown) => ({ type: 'tool_use', name, input });
const started = (stepIndex: number) => ev('workflow', { event: 'started', stepIndex, stepName: `s${stepIndex}` });
const askPermission = (requestId: string) => ev('permission', { requestId, toolName: 'Bash', input: {} });
const resolvePermission = (requestId: string, resolution = 'allow') =>
  ev('permission', { requestId, toolName: '', input: {}, resolution });

test('plan-mode turn (legacy shape): ExitPlanMode plan wins over trailing text', () => {
  const events = [
    user('plan this'),
    assistant(text('Looking around…')),
    assistant(tool('ExitPlanMode', { plan: '# Plan\n\nStep one.' }), text('Plan approved. Turn ends here.')),
  ];
  assert.equal(collectTurns(events, 0).at(-1)?.output, '# Plan\n\nStep one.');
});

test('plan-mode turn (current shape): plan file content wins over trailing text', () => {
  const events = [
    user('plan this'),
    assistant(tool('Write', { file_path: '/Users/x/.claude/plans/foo.md', content: '# Plan\n\nWritten.' })),
    assistant(tool('ExitPlanMode', {}), text('Plan approved.')),
  ];
  assert.equal(collectTurns(events, 0).at(-1)?.output, '# Plan\n\nWritten.');
});

test('a plans-file write with no ExitPlanMode falls back to the last text block', () => {
  const events = [
    user('tidy the plans dir'),
    assistant(tool('Write', { file_path: '/Users/x/.claude/plans/foo.md', content: '# Not the deliverable' })),
    assistant(text('Done.')),
  ];
  assert.equal(collectTurns(events, 0).at(-1)?.output, 'Done.');
});

test('a revised plan resolves to the last ExitPlanMode plan', () => {
  const events = [
    user('plan this'),
    assistant(tool('ExitPlanMode', { plan: 'first' })),
    assistant(tool('ExitPlanMode', { plan: 'second' }), text('trailing')),
  ];
  assert.equal(collectTurns(events, 0).at(-1)?.output, 'second');
});

test('a plain turn still yields its last text block', () => {
  const events = [user('go'), assistant(text('one')), assistant(text('two'))];
  assert.equal(collectTurns(events, 0).at(-1)?.output, 'two');
});

test('each user event opens a turn', () => {
  const events = [user('go'), assistant(text('a')), user('again'), assistant(text('b'))];
  assert.deepEqual(
    collectTurns(events, 0).map((t) => [t.user, t.output]),
    [
      ['go', 'a'],
      ['again', 'b'],
    ],
  );
});

test('findStepStart scopes the slice to the requested step', () => {
  const events = [started(1), user('one'), assistant(text('a')), started(2), user('two'), assistant(text('b'))];
  const step1 = collectTurns(events, findStepStart(events, 1));
  assert.deepEqual(
    step1.map((t) => t.output),
    ['a', 'b'],
  );
  const step2 = collectTurns(events, findStepStart(events, 2));
  assert.deepEqual(
    step2.map((t) => t.output),
    ['b'],
  );
});

test('findStepStart re-entering a step uses its latest pass', () => {
  const events = [started(1), user('one'), assistant(text('a')), started(1), user('retry'), assistant(text('b'))];
  assert.deepEqual(
    collectTurns(events, findStepStart(events, 1)).map((t) => t.output),
    ['b'],
  );
});

test('unresolvedPermissionIds returns requests with no recorded resolution', () => {
  const events = [
    askPermission('a'),
    askPermission('b'),
    resolvePermission('a'),
    user('go'),
    askPermission('c'),
    resolvePermission('c', 'deny'),
  ];
  assert.deepEqual(unresolvedPermissionIds(events), ['b']);
});

test('unresolvedPermissionIds tolerates a resolution arriving before its request', () => {
  assert.deepEqual(unresolvedPermissionIds([resolvePermission('a'), askPermission('a')]), []);
});

test('unresolvedPermissionIds ignores non-permission events and id-less entries', () => {
  const events = [user('go'), ev('permission', { toolName: 'Bash', input: {} }), askPermission('a')];
  assert.deepEqual(unresolvedPermissionIds(events), ['a']);
});

test('findStepStart falls back to the newest started marker, then to -1', () => {
  const events = [started(0), user('one'), assistant(text('a')), started(3), user('two')];
  assert.equal(findStepStart(events, 7), 3); // seq-independent: index of the started(3) event
  assert.equal(findStepStart([user('x')], 0), -1);
});
