import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StepContent } from '@lines/shared';
// Imported through shared/types.ts on purpose: that re-export closes an import
// cycle, and it only works while the re-export stays the file's last statement.
import {
  formatWorkflowIssues,
  MAX_WORKFLOW_NAME_LEN,
  validateStepContent,
  validateWorkflow,
  type StepForValidation,
} from '@lines/shared';

const content = (over: Partial<StepContent> = {}): StepContent => ({
  name: 'Plan',
  promptTemplate: 'Plan {task}',
  model: 'claude-opus-5-5',
  permissionMode: 'plan',
  autoAdvance: false,
  freshStart: false,
  ...over,
});

const inline = (over: Partial<StepContent> = {}): StepForValidation => ({
  content: content(over),
  isRef: false,
});

const messages = (issues: { message: string }[]) => issues.map((i) => i.message);

test('a well-formed workflow has no issues', () => {
  assert.deepEqual(validateWorkflow('Flow', [inline()], { strictModel: true }), []);
});

test('the name is required and length-capped', () => {
  assert.deepEqual(messages(validateWorkflow('  ', [inline()])), ['Workflow name is required']);
  const long = 'x'.repeat(MAX_WORKFLOW_NAME_LEN + 1);
  assert.deepEqual(messages(validateWorkflow(long, [inline()])), [
    `Workflow name must be ${MAX_WORKFLOW_NAME_LEN} characters or fewer`,
  ]);
});

test('a workflow with no steps is rejected', () => {
  assert.deepEqual(messages(validateWorkflow('Flow', [])), ['Add at least one step']);
});

test('an unresolvable pin and missing inline content produce different messages', () => {
  const issues = validateWorkflow('Flow', [
    { isRef: true },
    { isRef: false },
  ]);
  assert.deepEqual(messages(issues), ['Shared step unavailable', 'Step content is missing']);
  assert.deepEqual(issues.map((i) => i.field), ['ref', 'name']);
});

test('name and prompt are each required on an inline step', () => {
  const issues = validateWorkflow('Flow', [inline({ name: ' ', promptTemplate: '' })]);
  assert.deepEqual(messages(issues), ['Required', 'Prompt is required']);
  assert.deepEqual(issues.map((i) => i.stepIndex), [0, 0]);
});

test('an output name outside [A-Za-z0-9_-] is rejected', () => {
  const issues = validateStepContent(content({ outputName: 'my plan!' }));
  assert.deepEqual(messages(issues), ['Letters, digits, - and _ only']);
});

test('two steps publishing the same output name are both flagged', () => {
  const issues = validateWorkflow('Flow', [
    inline({ outputName: 'plan' }),
    inline({ name: 'Two', outputName: 'plan' }),
  ]);
  assert.deepEqual(messages(issues), [
    'Another step already publishes this name',
    'Another step already publishes this name',
  ]);
  assert.deepEqual(issues.map((i) => i.stepIndex), [0, 1]);
});

test('an output token must be published by an EARLIER step', () => {
  const forward = validateWorkflow('Flow', [
    inline({ promptTemplate: 'use {outputs.plan}' }),
    inline({ name: 'Two', outputName: 'plan' }),
  ]);
  assert.deepEqual(messages(forward), ['No earlier step publishes {outputs.plan}']);

  const backward = validateWorkflow('Flow', [
    inline({ outputName: 'plan' }),
    inline({ name: 'Two', promptTemplate: 'use {outputs.plan}' }),
  ]);
  assert.deepEqual(backward, []);
});

test('an unknown-output message lists every missing name once', () => {
  const issues = validateWorkflow('Flow', [
    inline({ promptTemplate: 'use {outputs.a} and {outputs.b} and {outputs.a}' }),
  ]);
  assert.deepEqual(messages(issues), ['No earlier step publishes {outputs.a}, {outputs.b}']);
});

test('a bad permission mode names the modes that exist', () => {
  const issues = validateStepContent(content({ permissionMode: 'yolo' as StepContent['permissionMode'] }));
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /^Unknown permission mode "yolo" — expected one of /);
});

/** strictModel is off for the editor (it must keep loading retired ids) and on for the tool surface. */
test('the model is only checked under strictModel', () => {
  assert.deepEqual(validateStepContent(content({ model: 'gpt-9' })), []);
  assert.deepEqual(messages(validateStepContent(content({ model: 'gpt-9' }), { strictModel: true })), [
    'Unknown model "gpt-9"',
  ]);
  assert.deepEqual(messages(validateStepContent(content({ model: '' }), { strictModel: true })), ['Required']);
  // A legacy alias still resolves, so it is not an error.
  assert.deepEqual(validateStepContent(content({ model: 'claude-opus-4-8' }), { strictModel: true }), []);
  assert.deepEqual(validateStepContent(content({ model: 'claude-opus-5' }), { strictModel: true }), []);
  assert.deepEqual(validateStepContent(content({ model: 'claude-sonnet-5' }), { strictModel: true }), []);
  assert.deepEqual(validateStepContent(content({ model: 'claude-fable-5' }), { strictModel: true }), []);
});

/**
 * A pinned ref's content belongs to its author and is immutable — re-reporting
 * its intrinsic problems would be unactionable for the consumer, so only the
 * cross-step rules apply.
 */
test("a ref's own content problems are not reported, but cross-step rules still are", () => {
  const ref: StepForValidation = { isRef: true, content: content({ name: '', model: 'gpt-9' }) };
  assert.deepEqual(validateWorkflow('Flow', [ref], { strictModel: true }), []);

  const clash = validateWorkflow('Flow', [
    inline({ outputName: 'plan' }),
    { isRef: true, content: content({ outputName: 'plan' }) },
  ]);
  assert.deepEqual(messages(clash), [
    'Another step already publishes this name',
    'Another step already publishes this name',
  ]);
});

test('formatWorkflowIssues distinguishes workflow-level and step-level issues', () => {
  const issues = validateWorkflow('  ', [inline({ promptTemplate: '' })]);
  assert.equal(
    formatWorkflowIssues(issues),
    'workflow: Workflow name is required; step 1 (prompt): Prompt is required',
  );
});
