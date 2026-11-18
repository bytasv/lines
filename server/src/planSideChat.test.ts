import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TranscriptEvent } from '@lines/shared';
import {
  describeToolCalls,
  PLAN_CHAT_SYSTEM_APPEND,
  planChatAnchor,
  planChatDisallowedTools,
  planChatPlanFile,
  planChatSystemAppend,
  planChatToolDecision,
} from './planSideChat.ts';

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
// Plan-file edits
// ---------------------------------------------------------------------------

const planRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-chat-')));
const plansDir = path.join(planRoot, '.claude', 'plans');
fs.mkdirSync(plansDir, { recursive: true });
const planFile = path.join(plansDir, 'x.md');
fs.writeFileSync(planFile, '# Plan\n');

const editVerdict = (tool: string, filePath: string, planPath?: string) =>
  planChatToolDecision(tool, { file_path: filePath, old_string: 'a', new_string: 'b', content: 'x' }, [planRoot], [], planPath)
    .allow;

test('Write and Edit of the card\'s own plan file are allowed', () => {
  assert.equal(editVerdict('Write', planFile, planFile), true);
  assert.equal(editVerdict('Edit', planFile, planFile), true);
});

test('every other write stays denied with a plan file set', () => {
  assert.equal(editVerdict('Write', path.join(plansDir, 'other.md'), planFile), false, 'sibling plan file');
  assert.equal(editVerdict('Edit', path.join(planRoot, 'README.md'), planFile), false, 'non-plan path');
  assert.equal(editVerdict('Edit', path.join(plansDir, '..', '..', 'README.md'), planFile), false, 'traversal');
  assert.equal(editVerdict('Write', `${plansDir}/../plans/../../x.md`, planFile), false, 'traversal out');
  assert.equal(editVerdict('MultiEdit', planFile, planFile), false, 'MultiEdit');
  assert.equal(editVerdict('NotebookEdit', planFile, planFile), false, 'NotebookEdit');
  assert.equal(
    planChatToolDecision('Write', { content: 'x' }, [planRoot], [], planFile).allow,
    false,
    'no file_path',
  );
});

test('Write and Edit are denied without a plan file', () => {
  assert.equal(editVerdict('Write', planFile), false);
  assert.equal(editVerdict('Edit', planFile), false);
});

test('a planPath outside a real plans directory never unlocks writes', () => {
  const stray = path.join(planRoot, 'notes.md');
  assert.equal(editVerdict('Write', stray, stray), false);
});

const planWrite = (uuid: string, filePath: string, name = 'Write', parent: string | null = null) =>
  assistant(uuid, [{ type: 'tool_use', id: `w-${uuid}`, name, input: { file_path: filePath, content: 'x' } }], parent);

test('planChatPlanFile finds the newest plan write before the card', () => {
  const events = [
    planWrite('w1', '/repo/.claude/plans/old.md'),
    planWrite('w2', '/repo/.claude/plans/new.md', 'Edit'),
    planWrite('w3', '/repo/src/a.ts'),
    exitPlan('a2'),
    card('p1'),
    planWrite('w4', '/repo/.claude/plans/after.md'),
  ];
  assert.equal(planChatPlanFile(events, 'p1'), '/repo/.claude/plans/new.md');
});

test('planChatPlanFile counts subagent writes', () => {
  const events = [planWrite('w1', '/repo/.claude/plans/sub.md', 'Write', 'task-1'), exitPlan('a2'), card('p1')];
  assert.equal(planChatPlanFile(events, 'p1'), '/repo/.claude/plans/sub.md');
});

test('planChatPlanFile stops at a provider switch and needs the card', () => {
  const events = [
    planWrite('w1', '/repo/.claude/plans/old.md'),
    ev('provider-switch', { from: 'gpt', to: 'claude' }),
    exitPlan('a2'),
    card('p1'),
  ];
  assert.equal(planChatPlanFile(events, 'p1'), null);
  assert.equal(planChatPlanFile([planWrite('w1', '/repo/.claude/plans/a.md'), card('p1')], 'other'), null);
});

test('the disallowed list and system append depend on the plan file', () => {
  const without = planChatDisallowedTools();
  assert.ok(without.includes('Edit') && without.includes('Write'));
  const withPlan = planChatDisallowedTools(planFile);
  assert.ok(!withPlan.includes('Edit') && !withPlan.includes('Write'));
  assert.ok(withPlan.includes('MultiEdit') && withPlan.includes('NotebookEdit') && withPlan.includes('ExitPlanMode'));
  assert.equal(planChatSystemAppend(), PLAN_CHAT_SYSTEM_APPEND);
  assert.ok(planChatSystemAppend(planFile).includes(planFile));
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
