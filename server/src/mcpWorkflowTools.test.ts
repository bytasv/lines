import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage, StepContent, WorkflowDef } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import {
  createMcpDispatcher,
  isLinesMcpTool,
  isReadOnlyLinesTool,
  LINES_TOOL_MANIFEST,
} from './mcpWorkflowTools.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import type { UserContext } from './userContext.ts';
import { WorkflowEngine } from './workflows.ts';
import * as commands from './workflowCommands.ts';
import type { StorageSyncClient } from './sync.ts';
import type { WorkerClient } from './workerClient.ts';

const USER = 'u1';

const content = (over: Partial<StepContent> = {}): StepContent => ({
  name: 'Plan',
  promptTemplate: 'Plan {task}',
  model: 'claude-opus-5',
  permissionMode: 'plan',
  autoAdvance: false,
  freshStart: false,
  ...over,
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-mcp-'));
  const store = createStore(root);
  const broadcasts: ServerMessage[] = [];
  const sessions = new SessionManager(store, new GuardAllowlist(store), (m) => broadcasts.push(m));
  sessions.attachWorker({ push: () => {}, close: () => {} } as unknown as WorkerClient);
  const workflows = new WorkflowEngine(store, sessions, (m) => broadcasts.push(m), USER);
  const syncCalls: string[] = [];
  const sync = {
    deleteWorkflow: (id: string) => syncCalls.push(`deleteWorkflow:${id}`),
    deleteStep: (id: string) => syncCalls.push(`deleteStep:${id}`),
    pullStepVersions: async () => null,
  } as unknown as StorageSyncClient;
  const ctx = { userId: USER, store, sessions, workflows, sync } as unknown as UserContext;
  return { ctx, workflows, sessions, syncCalls, call: createMcpDispatcher(ctx) };
}

/** The single text block every tool returns. */
const text = (result: { content: { text: string }[] }) => result.content[0]!.text;
const json = (result: { content: { text: string }[] }) => JSON.parse(text(result)) as Record<string, unknown>;

test('the manifest is what the read/write classification is derived from', () => {
  assert.equal(LINES_TOOL_MANIFEST.serverName, 'lines');
  for (const spec of LINES_TOOL_MANIFEST.tools) {
    assert.equal(isLinesMcpTool(`mcp__lines__${spec.name}`), true, spec.name);
    assert.equal(isReadOnlyLinesTool(`mcp__lines__${spec.name}`), spec.readOnly === true, spec.name);
    // Read tools are the list_*/get_* half; every other tool mutates.
    assert.equal(spec.readOnly === true, /^(list|get)_/.test(spec.name), spec.name);
  }
  assert.equal(isLinesMcpTool('Bash'), false);
  assert.equal(isLinesMcpTool('mcp__lines__nope'), false, 'not in the manifest');
  assert.equal(isReadOnlyLinesTool('mcp__other__list_things'), false, 'another server');
});

test('list_workflows reports the seeded default workflow', async () => {
  const h = harness();
  const rows = JSON.parse(text(await h.call('list_workflows', {}))) as { name: string; owned: boolean }[];
  assert.ok(rows.length >= 1);
  assert.equal(rows.every((r) => r.owned), true);
});

test('create_workflow saves and returns the resolved workflow', async () => {
  const h = harness();
  const result = await h.call('create_workflow', {
    name: 'Tiny',
    steps: [{ name: 'Do it', promptTemplate: 'Do {task}' }],
  });

  assert.equal(result.isError, undefined);
  const body = json(result) as { saved: boolean; workflow: { name: string; steps: Record<string, unknown>[] } };
  assert.equal(body.saved, true);
  assert.equal(body.workflow.name, 'Tiny');
  // Omitted fields take the editor's defaults rather than failing the call.
  assert.deepEqual(body.workflow.steps[0]!.model, 'claude-opus-5');
  assert.deepEqual(body.workflow.steps[0]!.permissionMode, 'default');
  assert.deepEqual(body.workflow.steps[0]!.autoAdvance, false);
  assert.ok(h.workflows.list().some((w) => w.name === 'Tiny'));
});

test('get_workflow accepts a name and resolves pinned steps', async () => {
  const h = harness();
  const step = commands.saveStep(h.ctx, { step: content({ name: 'Shared' }), published: true });
  commands.saveWorkflow(h.ctx, {
    workflow: {
      id: '',
      name: 'Pinned Flow',
      steps: [{ kind: 'ref', stepId: step.id, ownerId: USER, version: step.version }],
    } as WorkflowDef,
  });

  const body = json(await h.call('get_workflow', { workflow: 'pinned flow' }));
  const steps = body.steps as { name: string; pinned?: unknown }[];
  assert.equal(steps[0]!.name, 'Shared');
  assert.deepEqual(steps[0]!.pinned, { stepId: step.id, ownerId: USER, version: 1 });
});

test('get_workflow can read a foreign published workflow that writes would refuse', async () => {
  const h = harness();
  h.workflows.setShared([
    { id: 'f1', name: 'Theirs', steps: [content({ name: 'Theirs step' })], ownerId: 'u2', published: true },
  ]);

  const read = await h.call('get_workflow', { workflow: 'f1' });
  assert.equal(read.isError, undefined);
  assert.equal(json(read).owned, false);

  const write = await h.call('update_workflow', { workflow: 'f1', name: 'Hijacked' });
  assert.equal(write.isError, true);
  assert.match(text(write), /read-only/);
  assert.equal(h.workflows.listShared()[0]!.name, 'Theirs');
});

test('an ambiguous name is refused with both candidates named', async () => {
  const h = harness();
  for (let i = 0; i < 2; i++) {
    commands.saveWorkflow(h.ctx, { workflow: { id: '', name: 'Dup', steps: [content()] } as WorkflowDef });
  }

  const result = await h.call('update_workflow', { workflow: 'Dup', name: 'x' });
  assert.equal(result.isError, true);
  assert.match(text(result), /matches more than one/);
  assert.equal(h.workflows.list().filter((w) => w.name === 'Dup').length, 2, 'nothing written');
});

test('an unknown workflow is refused with the list of real ones', async () => {
  const h = harness();
  const result = await h.call('delete_workflow', { workflow: 'ghost' });
  assert.equal(result.isError, true);
  assert.match(text(result), /No workflow you own matches "ghost"/);
});

test('a malformed create_workflow is rejected before the engine sees it', async () => {
  const h = harness();
  const before = h.workflows.list().length;

  const noName = await h.call('create_workflow', { name: '  ', steps: [{ name: 'a', promptTemplate: 'b' }] });
  assert.equal(noName.isError, true);
  assert.match(text(noName), /Workflow name is required/);

  const noSteps = await h.call('create_workflow', { name: 'Empty', steps: [] });
  assert.equal(noSteps.isError, true);
  assert.match(text(noSteps), /Add at least one step/);

  const badPrompt = await h.call('create_workflow', { name: 'Blank', steps: [{ name: 'a' }] });
  assert.equal(badPrompt.isError, true);
  assert.match(text(badPrompt), /step 1 \(prompt\): Prompt is required/);

  const badModel = await h.call('create_workflow', {
    name: 'Bad model',
    steps: [{ name: 'a', promptTemplate: 'b', model: 'gpt-9' }],
  });
  assert.equal(badModel.isError, true);
  assert.match(text(badModel), /Unknown model "gpt-9"/);

  const badMode = await h.call('create_workflow', {
    name: 'Bad mode',
    steps: [{ name: 'a', promptTemplate: 'b', permissionMode: 'yolo' }],
  });
  assert.equal(badMode.isError, true);
  assert.match(text(badMode), /Unknown permission mode "yolo"/);

  const forwardRef = await h.call('create_workflow', {
    name: 'Forward',
    steps: [
      { name: 'a', promptTemplate: 'use {outputs.later}' },
      { name: 'b', promptTemplate: 'x', outputName: 'later' },
    ],
  });
  assert.equal(forwardRef.isError, true);
  assert.match(text(forwardRef), /No earlier step publishes \{outputs\.later\}/);

  const dupOutput = await h.call('create_workflow', {
    name: 'Dup output',
    steps: [
      { name: 'a', promptTemplate: 'x', outputName: 'plan' },
      { name: 'b', promptTemplate: 'y', outputName: 'plan' },
    ],
  });
  assert.equal(dupOutput.isError, true);
  assert.match(text(dupOutput), /Another step already publishes this name/);

  assert.equal(h.workflows.list().length, before, 'no partial writes');
});

test('a step ref needs all three pin fields, and an unresolvable pin fails validation', async () => {
  const h = harness();

  const incomplete = await h.call('create_workflow', {
    name: 'Bad ref',
    steps: [{ kind: 'ref', stepId: 'x' }],
  });
  assert.equal(incomplete.isError, true);
  assert.match(text(incomplete), /needs stepId, ownerId and version/);

  const ghost = await h.call('create_workflow', {
    name: 'Ghost ref',
    steps: [{ kind: 'ref', stepId: 'x', ownerId: 'u2', version: 3 }],
  });
  assert.equal(ghost.isError, true);
  assert.match(text(ghost), /Shared step unavailable/);
});

test('steps must be an array', async () => {
  const h = harness();
  const result = await h.call('create_workflow', { name: 'x', steps: 'nope' });
  assert.equal(result.isError, true);
  assert.match(text(result), /`steps` must be an array/);
});

test('update_workflow patches only the fields it is given', async () => {
  const h = harness();
  const saved = commands.saveWorkflow(h.ctx, {
    workflow: { id: '', name: 'Before', steps: [content({ name: 'Keep' })] } as WorkflowDef,
  });

  const body = json(await h.call('update_workflow', { workflow: saved.id, name: 'After' }));
  const view = body.workflow as { name: string; steps: { name: string }[] };
  assert.equal(view.name, 'After');
  assert.deepEqual(view.steps.map((s) => s.name), ['Keep'], 'steps untouched');
});

test('update_workflow names the sessions a change lands under', async () => {
  const h = harness();
  const saved = commands.saveWorkflow(h.ctx, {
    workflow: { id: '', name: 'Live', steps: [content()] } as WorkflowDef,
  });
  const meta = h.sessions.createSession({
    name: 'S',
    cwd: '/tmp',
    model: 'claude-opus-5',
    permissionMode: 'default',
    compressResponses: false,
  });
  h.workflows.attach(meta.id, saved.id);

  const body = json(await h.call('update_workflow', { workflow: 'Live', name: 'Live v2' }));
  assert.deepEqual(body.runningSessions, [{ sessionId: meta.id, name: 'S' }]);
});

test('delete_workflow removes it and tells storage', async () => {
  const h = harness();
  const saved = commands.saveWorkflow(h.ctx, {
    workflow: { id: '', name: 'Doomed', steps: [content()] } as WorkflowDef,
  });

  const body = json(await h.call('delete_workflow', { workflow: 'doomed' }));
  assert.equal(body.deleted, true);
  assert.equal(h.workflows.list().some((w) => w.id === saved.id), false);
  assert.deepEqual(h.syncCalls, [`deleteWorkflow:${saved.id}`]);
});

test('save_step validates, then versions', async () => {
  const h = harness();
  const bad = await h.call('save_step', { name: 'x', promptTemplate: 'y', outputName: 'not ok!' });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /Letters, digits, - and _ only/);
  assert.equal(h.workflows.listSteps().length, 0);

  const body = json(await h.call('save_step', { name: 'Reusable', promptTemplate: 'Do {task}', published: true }));
  const step = body.step as { id: string; version: number; published: boolean };
  assert.equal(step.version, 1);
  assert.equal(step.published, true);

  const again = json(await h.call('save_step', { stepId: step.id, name: 'Reusable', promptTemplate: 'changed' }));
  assert.equal((again.step as { version: number }).version, 2);
});

test('save_step refuses a stepId the user does not own', async () => {
  const h = harness();
  const result = await h.call('save_step', { stepId: 'someone-elses', name: 'x', promptTemplate: 'y' });
  assert.equal(result.isError, true);
  assert.match(text(result), /Omit stepId to create a new one/);
  assert.equal(h.workflows.listSteps().length, 0);
});

test('delete_step refuses an id the user does not own, then works on one they do', async () => {
  const h = harness();
  const missing = await h.call('delete_step', { stepId: 'ghost' });
  assert.equal(missing.isError, true);
  assert.deepEqual(h.syncCalls, []);

  const step = commands.saveStep(h.ctx, { step: content(), published: false });
  const body = json(await h.call('delete_step', { stepId: step.id }));
  assert.equal(body.deleted, true);
  assert.deepEqual(h.syncCalls, [`deleteStep:${step.id}`]);
});

test('get_step and list_step_versions read the version history', async () => {
  const h = harness();
  const step = commands.saveStep(h.ctx, { step: content(), published: true });
  commands.saveStep(h.ctx, { step: content({ promptTemplate: 'v2' }), stepId: step.id, published: true });

  const head = json(await h.call('get_step', { stepId: step.id }));
  assert.equal(head.version, 2);

  const pinned = json(await h.call('get_step', { stepId: step.id, version: 1 }));
  assert.equal(pinned.promptTemplate, 'Plan {task}');

  const versions = JSON.parse(text(await h.call('list_step_versions', { stepId: step.id }))) as { version: number }[];
  assert.deepEqual(versions.map((v) => v.version), [2, 1]);

  const missing = await h.call('get_step', { stepId: 'ghost' });
  assert.equal(missing.isError, true);
});

test('an unknown tool name is an error result, not a throw', async () => {
  const h = harness();
  const result = await h.call('frobnicate', {});
  assert.equal(result.isError, true);
  assert.match(text(result), /Unknown tool "frobnicate"/);
});

test('a WS-shaped save and an MCP-shaped save converge on the same engine state', async () => {
  const a = harness();
  const b = harness();
  const steps = [content({ name: 'One', outputName: 'one' }), content({ name: 'Two', promptTemplate: 'use {outputs.one}' })];

  // The WS path: index.ts hands the payload straight to workflowCommands.
  const viaWs = commands.saveWorkflow(a.ctx, {
    workflow: { id: '', name: 'Same', steps } as WorkflowDef,
    ownerName: 'Ada',
  });

  commands.saveStep(b.ctx, { step: content(), published: false, ownerName: 'Ada' }); // seeds ownerDisplayName
  const viaMcp = json(
    await b.call('create_workflow', {
      name: 'Same',
      steps: steps.map((s) => ({ ...s })),
    }),
  ).workflow as { name: string; ownerName?: string; steps: { name: string; promptTemplate: string }[] };

  assert.equal(viaMcp.name, viaWs.name);
  assert.equal(viaMcp.ownerName, 'Ada');
  assert.deepEqual(
    viaMcp.steps.map((s) => [s.name, s.promptTemplate]),
    steps.map((s) => [s.name, s.promptTemplate]),
  );
});
