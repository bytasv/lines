import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TranscriptEvent } from '@lines/shared';
import { describeToolCalls, planChatAnchor, planChatToolDecision } from './planSideChat.ts';

let seq = 0;
const ev = (kind: TranscriptEvent['kind'], data: unknown): TranscriptEvent =>
  ({ seq: ++seq, ts: 0, kind, data }) as TranscriptEvent;
const assistant = (uuid: string, content: unknown[], parent: string | null = null) =>
  ev('sdk', { type: 'assistant', uuid, parent_tool_use_id: parent, message: { content } });
const exitPlan = (uuid: string) =>
  assistant(uuid, [{ type: 'tool_use', id: `t-${uuid}`, name: 'ExitPlanMode', input: { plan: 'P' } }]);
const card = (requestId: string) => ev('permission', { requestId, toolName: 'ExitPlanMode', input: {} });

// ---------------------------------------------------------------------------
// planChatAnchor
// ---------------------------------------------------------------------------

test('anchors on the assistant message before the one carrying ExitPlanMode', () => {
  const events = [ev('user', { text: 'x' }), assistant('a1', [{ type: 'text', text: 'hi' }]), exitPlan('a2'), card('p1')];
  assert.equal(planChatAnchor(events, 'p1'), 'a1');
});

test('skips subagent messages, which a fork cannot anchor on', () => {
  const events = [
    assistant('a1', [{ type: 'text', text: 'hi' }]),
    assistant('sub', [{ type: 'text', text: 'sub' }], 'task-1'),
    exitPlan('a2'),
    card('p1'),
  ];
  assert.equal(planChatAnchor(events, 'p1'), 'a1');
});

test('falls back to the newest assistant message when the tool_use was never recorded', () => {
  const events = [assistant('a1', [{ type: 'text', text: 'hi' }]), card('p1')];
  assert.equal(planChatAnchor(events, 'p1'), 'a1');
});

test('null when nothing precedes the plan', () => {
  assert.equal(planChatAnchor([exitPlan('a2'), card('p1')], 'p1'), null);
  assert.equal(planChatAnchor([assistant('a1', []), card('p1')], 'other'), null);
});

test('never anchors across a provider switch', () => {
  const events = [
    assistant('old', [{ type: 'text', text: 'codex era' }]),
    ev('provider-switch', { from: 'gpt', to: 'claude' }),
    exitPlan('a2'),
    card('p1'),
  ];
  assert.equal(planChatAnchor(events, 'p1'), null);
});

// ---------------------------------------------------------------------------
// planChatToolDecision
// ---------------------------------------------------------------------------

const roots = ['/repo'];
const allowed = (tool: string, input: Record<string, unknown> = {}) =>
  planChatToolDecision(tool, input, roots, []).allow;

test('reads are allowed', () => {
  assert.equal(allowed('Read', { file_path: '/repo/a.ts' }), true);
  assert.equal(allowed('Grep', { pattern: 'x', path: '/repo' }), true);
  assert.equal(allowed('Bash', { command: 'ls -la' }), true);
});

test('writes, plan-mode controls, questions and subagents are denied', () => {
  for (const [tool, input] of [
    ['Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: '/repo/a.ts', content: 'x' }],
    ['Bash', { command: 'rm -rf build' }],
    ['ExitPlanMode', { plan: 'P' }],
    ['EnterPlanMode', {}],
    ['AskUserQuestion', { questions: [] }],
    ['Agent', { prompt: 'go' }],
    ['Task', { prompt: 'go' }],
    ['Skill', { skill: 'x' }],
    ['mcp__lines__save_step', {}],
    ['mcp__lines__get_workflow', {}],
  ] as const) {
    const verdict = planChatToolDecision(tool, input as Record<string, unknown>, roots, []);
    assert.equal(verdict.allow, false, tool);
  }
});

// ---------------------------------------------------------------------------
// describeToolCalls
// ---------------------------------------------------------------------------

test('tool calls get a short label, the last call winning', () => {
  assert.equal(describeToolCalls([{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/a.ts' } }]), 'Reading a.ts');
  assert.equal(
    describeToolCalls([
      { type: 'text', text: 'x' },
      { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'git log --oneline\nls' } },
    ]),
    'Running `git log --oneline`',
  );
  assert.equal(describeToolCalls([{ type: 'text', text: 'no tools' }]), undefined);
  assert.equal(describeToolCalls('nope'), undefined);
});
