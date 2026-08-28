import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { PermissionMode, PermissionRequestData, SessionMeta } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import type { WorkerClient, WorkerRpc } from './workerClient.ts';

const meta = (permissionMode: PermissionMode): SessionMeta =>
  ({
    id: 's1',
    name: 's1',
    cwd: '/tmp',
    model: 'claude-opus-5',
    permissionMode,
    compressResponses: false,
    status: 'running',
    createdAt: 1,
  }) as SessionMeta;

function harness(permissionMode: PermissionMode = 'default') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-mcp-gate-'));
  const store = createStore(root);
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta(permissionMode)]));
  const sessions = new SessionManager(store, new GuardAllowlist(store), () => {});
  const answered: unknown[] = [];
  sessions.attachWorker({
    push: () => {},
    close: () => {},
    rpcResult: (_id: string, result: unknown) => answered.push(result),
  } as unknown as WorkerClient);
  return {
    sessions,
    answered,
    cards: () =>
      store
        .loadTranscript('s1')
        .filter((e) => e.kind === 'permission')
        .map((e) => e.data as PermissionRequestData),
  };
}

const preToolUse = (toolName: string): WorkerRpc => ({
  id: 'r1',
  sessionId: 's1',
  kind: 'preToolUse',
  resend: false,
  payload: { tool_name: toolName, tool_input: { workflow: 'w1' } },
});

const canUseTool = (toolName: string): WorkerRpc => ({
  id: 'r2',
  sessionId: 's1',
  kind: 'canUseTool',
  resend: false,
  payload: { toolName, input: { workflow: 'w1' } },
});

/** Let the fire-and-forget rpc chain settle (no timers involved). */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

type HookAnswer = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };

test('a read tool is allowed by the hook without a card, in every mode', async () => {
  for (const mode of ['default', 'auto', 'plan'] as PermissionMode[]) {
    const h = harness(mode);
    await h.sessions.handleWorkerRpc(preToolUse('mcp__lines__list_workflows'));

    const answer = h.answered[0] as HookAnswer;
    assert.equal(answer.hookSpecificOutput?.permissionDecision, 'allow', mode);
    // Recorded, but as an auto-approval rather than a question.
    assert.deepEqual(
      h.cards().map((c) => [c.resolution, c.auto]),
      [['allow', true]],
      mode,
    );
  }
});

test('a write tool is escalated to a card by the hook, even in auto mode', async () => {
  for (const mode of ['default', 'auto'] as PermissionMode[]) {
    const h = harness(mode);
    await h.sessions.handleWorkerRpc(preToolUse('mcp__lines__update_workflow'));

    const answer = h.answered[0] as HookAnswer;
    assert.equal(answer.hookSpecificOutput?.permissionDecision, 'ask', mode);
    assert.equal(
      answer.hookSpecificOutput?.permissionDecisionReason,
      'Changes a saved workflow or step.',
      mode,
    );
    assert.deepEqual(h.cards(), [], 'nothing auto-approved');
  }
});

test('canUseTool auto-allows a read tool outside auto mode too', async () => {
  const h = harness('default');
  await h.sessions.handleWorkerRpc(canUseTool('mcp__lines__get_workflow'));

  assert.deepEqual(h.answered, [{ behavior: 'allow', updatedInput: { workflow: 'w1' } }]);
  assert.deepEqual(h.cards().map((c) => c.resolution), ['allow']);
  assert.notEqual(h.sessions.get('s1')?.status, 'waiting-permission');
});

test('canUseTool parks a write tool on the permission card instead of self-approving', async () => {
  const h = harness('auto');
  void h.sessions.handleWorkerRpc(canUseTool('mcp__lines__delete_workflow'));
  await settle();

  assert.deepEqual(h.answered, [], 'still waiting on the user');
  assert.equal(h.sessions.get('s1')?.status, 'waiting-permission');
  const card = h.cards().at(-1)!;
  assert.equal(card.toolName, 'mcp__lines__delete_workflow');
  assert.equal(card.resolution, undefined, 'unanswered');

  // Approving it answers the worker with the original input.
  h.sessions.resolvePermission('s1', 'r2', true);
  await settle();
  assert.deepEqual(h.answered, [{ behavior: 'allow', updatedInput: { workflow: 'w1' } }]);
});

test('a tool from another MCP server is untouched by this routing', async () => {
  const h = harness('default');
  await h.sessions.handleWorkerRpc(preToolUse('mcp__pencil__batch_get'));

  // Falls through to the normal guard path, which has nothing to say about it.
  assert.deepEqual(h.answered, [{ continue: true }]);
  assert.deepEqual(h.cards(), []);
});
