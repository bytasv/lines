import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assessToolCall, isSafePlanWrite, isSafeReadOnly } from './autoGuard.ts';

const cwd = '/Users/x/Projects/lines';
const home = os.homedir();
const homePlan = path.join(home, '.claude', 'plans', 'my-plan.md');
const projectPlan = path.join(cwd, '.claude', 'plans', 'my-plan.md');
// Kept unnormalised on purpose: isPlanPath must resolve, not substring-match.
const traversal = `${home}/.claude/plans/../../.ssh/id_rsa`;
const traversalOutOfTree = `/tmp/x/.claude/plans/../../../../etc/hosts`;

test('reading the home plan file is observation-only', () => {
  assert.equal(isSafeReadOnly('Read', { file_path: homePlan }, cwd, []), true);
  assert.equal(assessToolCall('Read', { file_path: homePlan }, cwd, []).dangerous, false);
});

test('reading a project-local plan file is observation-only', () => {
  assert.equal(isSafeReadOnly('Read', { file_path: projectPlan }, cwd, []), true);
});

test('Write/Edit/MultiEdit of a plan file is a safe plan write', () => {
  assert.equal(isSafePlanWrite('Write', { file_path: homePlan }, cwd), true);
  assert.equal(isSafePlanWrite('Edit', { file_path: homePlan }, cwd), true);
  assert.equal(isSafePlanWrite('MultiEdit', { file_path: projectPlan }, cwd), true);
  assert.equal(isSafePlanWrite('NotebookEdit', { notebook_path: homePlan }, cwd), true);
});

test('non-file tools are never a safe plan write', () => {
  assert.equal(isSafePlanWrite('Bash', { command: `cat ${homePlan}` }, cwd), false);
  assert.equal(isSafePlanWrite('Read', { file_path: homePlan }, cwd), false);
});

test('writing outside the plan directory is not a safe plan write', () => {
  assert.equal(isSafePlanWrite('Write', { file_path: path.join(home, 'notes.md') }, cwd), false);
  assert.equal(isSafePlanWrite('Write', {}, cwd), false);
});

test('traversal out of the plan directory is not treated as a plan path', () => {
  assert.equal(isSafePlanWrite('Write', { file_path: traversal }, cwd), false);
  assert.equal(isSafeReadOnly('Read', { file_path: traversal }, cwd, []), false);
  const verdict = assessToolCall('Read', { file_path: traversal }, cwd, []);
  assert.equal(verdict.dangerous, true);
  assert.equal(verdict.reason, 'Touches credential/secret files outside the project');

  assert.equal(isSafePlanWrite('Write', { file_path: traversalOutOfTree }, cwd), false);
  assert.equal(
    assessToolCall('Write', { file_path: traversalOutOfTree }, cwd, []).reason,
    'File access outside the working directory',
  );
});

test('credential and out-of-cwd file access still escalates', () => {
  assert.equal(
    assessToolCall('Read', { file_path: path.join(home, '.ssh', 'config') }, cwd, []).reason,
    'Touches credential/secret files outside the project',
  );
  assert.equal(
    assessToolCall('Read', { file_path: '/tmp/other/.env' }, cwd, []).reason,
    'Touches credential/secret files outside the project',
  );
  assert.equal(
    assessToolCall('Read', { file_path: '/tmp/other/app.ts' }, cwd, []).reason,
    'File access outside the working directory',
  );
});

test('in-cwd writes keep their existing verdict', () => {
  assert.equal(
    assessToolCall('Write', { file_path: path.join(cwd, 'server/src/a.ts') }, cwd, []).dangerous,
    false,
  );
});

test('ExitPlanMode and AskUserQuestion always reach the user', () => {
  assert.equal(isSafeReadOnly('ExitPlanMode', {}, cwd, []), false);
  assert.equal(isSafeReadOnly('AskUserQuestion', {}, cwd, []), false);
  assert.equal(isSafePlanWrite('ExitPlanMode', { file_path: homePlan }, cwd), false);
});
