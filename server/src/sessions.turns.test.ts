import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TranscriptEvent } from '@lines/shared';
import { collectTurns, findStepStart, scanTurnActivity, unresolvedPermissionIds } from './sessions.ts';

let seq = 0;
const ev = (kind: TranscriptEvent['kind'], data: unknown): TranscriptEvent =>
  ({ seq: ++seq, ts: 0, kind, data }) as TranscriptEvent;

const user = (text: string) => ev('user', { text });
const assistant = (...content: unknown[]) => ev('sdk', { type: 'assistant', message: { content } });
const text = (t: string) => ({ type: 'text', text: t });
const tool = (name: string, input: unknown) => ({ type: 'tool_use', name, input });
/** An assistant message produced by a subagent spawned by the `Task` call `parentId`. */
const subAssistant = (parentId: string, ...content: unknown[]) =>
  ev('sdk', { type: 'assistant', parent_tool_use_id: parentId, message: { content } });
const idTool = (id: string, name: string, input: unknown = {}) => ({ type: 'tool_use', id, name, input });
const toolResult = (toolUseId: string, isError = false) =>
  ev('sdk', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError }] } });
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

/** A real `<root>/.claude/plans/plan.md`, so the on-disk read is exercised. */
function planRoot(contents: string): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-plan-'));
  const dir = path.join(root, '.claude', 'plans');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'plan.md');
  fs.writeFileSync(file, contents);
  return { root, file };
}

test('a plan revised by Edit resolves to the file on disk, not the trailing text', () => {
  const { root, file } = planRoot('# Plan\n\nRevised, with rollback.');
  const events = [
    user('plan this'),
    assistant(tool('Write', { file_path: file, content: '# Plan\n\nFirst draft.' })),
    // An Edit carries no `content` — before the disk read this turn fell back to 'Done.'
    assistant(tool('Edit', { file_path: file, old_string: 'First draft.', new_string: 'Revised.' })),
    assistant(tool('ExitPlanMode', {}), text('Done.')),
  ];
  assert.equal(collectTurns(events, 0, [root]).at(-1)?.output, '# Plan\n\nRevised, with rollback.');
});

test('an unreadable plan file degrades to the captured Write content', () => {
  const { root, file } = planRoot('# Plan\n\nOn disk.');
  fs.rmSync(file);
  const events = [
    user('plan this'),
    assistant(tool('Write', { file_path: file, content: '# Plan\n\nCaptured.' })),
    assistant(tool('ExitPlanMode', {}), text('Done.')),
  ];
  assert.equal(collectTurns(events, 0, [root]).at(-1)?.output, '# Plan\n\nCaptured.');
});

test('a plan file outside every root is not read from disk', () => {
  const { root, file } = planRoot('# Plan\n\nOther project.');
  const events = [
    user('plan this'),
    assistant(tool('Write', { file_path: file, content: '# Plan\n\nCaptured.' })),
    assistant(tool('ExitPlanMode', {}), text('Done.')),
  ];
  // Roots list omits `root`, so isPlanPath rejects the path even though it exists.
  assert.equal(collectTurns(events, 0, ['/Users/x/Projects/other']).at(-1)?.output, '# Plan\n\nCaptured.');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a subagent answering after the main agent does not become the turn output', () => {
  const events = [
    user('map the server'),
    assistant(idTool('task_1', 'Task', { subagent_type: 'Explore', description: 'map server/src' })),
    assistant(text('Done — 12 modules.')),
    // The subagent's own final message can land after the main agent's.
    subAssistant('task_1', text('Here is my raw exploration dump.')),
  ];
  assert.equal(collectTurns(events, 0).at(-1)?.output, 'Done — 12 modules.');
});

test('a subagent exiting plan mode does not turn the main turn into a plan turn', () => {
  const events = [
    user('use the Plan agent'),
    assistant(idTool('task_1', 'Task', { subagent_type: 'Plan', description: 'plan it' })),
    subAssistant('task_1', tool('Write', { file_path: '/Users/x/.claude/plans/foo.md', content: '# Subagent plan' })),
    subAssistant('task_1', tool('ExitPlanMode', { plan: '# Subagent plan' })),
    assistant(text('The subagent drafted a plan.')),
  ];
  assert.equal(collectTurns(events, 0).at(-1)?.output, 'The subagent drafted a plan.');
});

test('scanTurnActivity keeps the Task call but drops the subagent it spawned', () => {
  const events = [
    user('map the server'),
    assistant(idTool('task_1', 'Task', { subagent_type: 'Explore', description: 'map server/src' })),
    subAssistant('task_1', text('subagent chatter'), idTool('read_1', 'Read', { file_path: '/a.ts' })),
    assistant(idTool('bash_1', 'Bash', { command: 'npm test' })),
    toolResult('bash_1', true),
    assistant(text('Main agent conclusion.')),
  ];
  const scan = scanTurnActivity(events);
  assert.deepEqual(
    scan.toolCalls.map((t) => t.name),
    ['Task', 'Bash'],
  );
  assert.equal(scan.finalText, 'Main agent conclusion.');
  assert.ok(scan.toolErrors.has('bash_1'));
});

test('findStepStart falls back to the newest started marker, then to -1', () => {
  const events = [started(0), user('one'), assistant(text('a')), started(3), user('two')];
  assert.equal(findStepStart(events, 7), 3); // seq-independent: index of the started(3) event
  assert.equal(findStepStart([user('x')], 0), -1);
});
