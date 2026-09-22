import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { PermissionMode, SessionMeta } from '@lines/shared';
import { assessToolCall, GuardAllowlist, isPlanPath, isSafePlanWrite, isSafeReadOnly } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import type { WorkerClient, WorkerRpc } from './workerClient.ts';

const cwd = '/Users/x/Projects/lines';
/** The guard takes every root a session may work in; this suite is single-root. */
const roots = [cwd];
const home = os.homedir();
const homePlan = path.join(home, '.claude', 'plans', 'my-plan.md');
const projectPlan = path.join(cwd, '.claude', 'plans', 'my-plan.md');
// Kept unnormalised on purpose: isPlanPath must resolve, not substring-match.
const traversal = `${home}/.claude/plans/../../.ssh/id_rsa`;
const traversalOutOfTree = `/tmp/x/.claude/plans/../../../../etc/hosts`;

test('reading the home plan file is observation-only', () => {
  assert.equal(isSafeReadOnly('Read', { file_path: homePlan }, roots, []), true);
  assert.equal(assessToolCall('Read', { file_path: homePlan }, roots, []).dangerous, false);
});

test('reading a project-local plan file is observation-only', () => {
  assert.equal(isSafeReadOnly('Read', { file_path: projectPlan }, roots, []), true);
});

test('Write/Edit/MultiEdit of a plan file is a safe plan write', () => {
  assert.equal(isSafePlanWrite('Write', { file_path: homePlan }, roots), true);
  assert.equal(isSafePlanWrite('Edit', { file_path: homePlan }, roots), true);
  assert.equal(isSafePlanWrite('MultiEdit', { file_path: projectPlan }, roots), true);
  assert.equal(isSafePlanWrite('NotebookEdit', { notebook_path: homePlan }, roots), true);
});

test('non-file tools are never a safe plan write', () => {
  assert.equal(isSafePlanWrite('Bash', { command: `cat ${homePlan}` }, roots), false);
  assert.equal(isSafePlanWrite('Read', { file_path: homePlan }, roots), false);
});

test('writing outside the plan directory is not a safe plan write', () => {
  assert.equal(isSafePlanWrite('Write', { file_path: path.join(home, 'notes.md') }, roots), false);
  assert.equal(isSafePlanWrite('Write', {}, roots), false);
});

test('traversal out of the plan directory is not treated as a plan path', () => {
  assert.equal(isSafePlanWrite('Write', { file_path: traversal }, roots), false);
  assert.equal(isSafeReadOnly('Read', { file_path: traversal }, roots, []), false);
  const verdict = assessToolCall('Read', { file_path: traversal }, roots, []);
  assert.equal(verdict.dangerous, true);
  assert.equal(verdict.reason, 'Touches credential/secret files outside the project');

  assert.equal(isSafePlanWrite('Write', { file_path: traversalOutOfTree }, roots), false);
  assert.equal(
    assessToolCall('Write', { file_path: traversalOutOfTree }, roots, []).reason,
    'File access outside the working directory',
  );
});

test('credential and out-of-cwd file access still escalates', () => {
  assert.equal(
    assessToolCall('Read', { file_path: path.join(home, '.ssh', 'config') }, roots, []).reason,
    'Touches credential/secret files outside the project',
  );
  assert.equal(
    assessToolCall('Read', { file_path: '/tmp/other/.env' }, roots, []).reason,
    'Touches credential/secret files outside the project',
  );
  assert.equal(
    assessToolCall('Read', { file_path: '/tmp/other/app.ts' }, roots, []).reason,
    'File access outside the working directory',
  );
});

test('in-cwd writes keep their existing verdict', () => {
  assert.equal(
    assessToolCall('Write', { file_path: path.join(cwd, 'server/src/a.ts') }, roots, []).dangerous,
    false,
  );
});

// isPlanPath is exported because the /file route and the step-output plan read
// both gate on it, so its containment rules are asserted directly here.
test('isPlanPath accepts the home and project plan directories', () => {
  assert.equal(isPlanPath(homePlan, roots), true);
  assert.equal(isPlanPath(projectPlan, roots), true);
  // The home plans dir is cwd-independent — no roots needed.
  assert.equal(isPlanPath(homePlan, []), true);
});

test('isPlanPath rejects traversal out of a plan directory', () => {
  assert.equal(isPlanPath(traversal, roots), false);
  assert.equal(isPlanPath(traversalOutOfTree, roots), false);
  assert.equal(isPlanPath(`${home}/.claude/plans/../../../.ssh/id_rsa`, roots), false);
});

test('isPlanPath rejects paths outside every plan directory', () => {
  assert.equal(isPlanPath('/etc/passwd', roots), false);
  assert.equal(isPlanPath(path.join(cwd, 'server/src/index.ts'), roots), false);
  assert.equal(isPlanPath(projectPlan, []), false);
});

test('ExitPlanMode and AskUserQuestion always reach the user', () => {
  assert.equal(isSafeReadOnly('ExitPlanMode', {}, roots, []), false);
  assert.equal(isSafeReadOnly('AskUserQuestion', {}, roots, []), false);
  assert.equal(isSafePlanWrite('ExitPlanMode', { file_path: homePlan }, roots), false);
});

/** A manager over a throwaway store holding one session in `permissionMode`. */
function hookHarness(permissionMode: PermissionMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-always-ask-'));
  const store = createStore(root);
  fs.writeFileSync(
    path.join(root, 'sessions.json'),
    JSON.stringify([
      {
        id: 's1',
        name: 's1',
        cwd,
        model: 'claude-opus-5-5',
        permissionMode,
        status: 'running',
        createdAt: 1,
      } as SessionMeta,
    ]),
  );
  const sessions = new SessionManager(store, new GuardAllowlist(store), () => {});
  const answered: unknown[] = [];
  sessions.attachWorker({
    push: () => {},
    close: () => {},
    rpcResult: (_id: string, result: unknown) => answered.push(result),
  } as unknown as WorkerClient);
  return { sessions, answered };
}

const preToolUse = (toolName: string): WorkerRpc => ({
  id: 'r1',
  sessionId: 's1',
  kind: 'preToolUse',
  resend: false,
  payload: { tool_name: toolName, tool_input: {} },
});

test('bypass mode allows a tool the guard would otherwise prompt for', async () => {
  const h = hookHarness('bypassPermissions');
  await h.sessions.handleWorkerRpc(preToolUse('Bash'));
  const answer = h.answered[0] as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(answer.hookSpecificOutput?.permissionDecision, 'allow');
});

test('bypass mode still asks for a Lines workflow write', async () => {
  const h = hookHarness('bypassPermissions');
  await h.sessions.handleWorkerRpc(preToolUse('mcp__lines__save_step'));
  const answer = h.answered[0] as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(answer.hookSpecificOutput?.permissionDecision, 'ask');
});

test('the hook forces a prompt for always-ask tools in every mode', async () => {
  const modes: PermissionMode[] = ['default', 'plan', 'auto', 'bypassPermissions'];
  for (const mode of modes) {
    for (const tool of ['ExitPlanMode', 'AskUserQuestion']) {
      const h = hookHarness(mode);
      await h.sessions.handleWorkerRpc(preToolUse(tool));
      const answer = h.answered[0] as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      // A bare `continue: true` would let bypassPermissions / settings.json
      // permissions.allow resolve this before canUseTool ever runs.
      assert.equal(answer.hookSpecificOutput?.permissionDecision, 'ask', `${tool} in ${mode}`);
      assert.equal(
        answer.hookSpecificOutput?.permissionDecisionReason,
        'This decision is always the user’s.',
        `${tool} in ${mode}`,
      );
    }
  }
});
