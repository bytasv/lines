import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RoutingRule, ServerMessage, SessionMeta, UserUiSettings, WorkflowDef } from '@lines/shared';
import type { AuthManager } from './auth.ts';
import { GuardAllowlist } from './autoGuard.ts';
import type { JevDecision } from './jev.ts';
import { McpConnections } from './mcpConnections.ts';
import type { OpenaiAuthManager } from './openaiAuth.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import { WorkflowEngine } from './workflows.ts';

/**
 * Smart routing at the push, with JEV stubbed on `SessionManager.decideTurn`.
 *
 * No AuthManager is wired on the Claude cases, which keeps the push path free of
 * the CLI check (see pushTurn) — the same trick sessions.effort.test.ts uses.
 * The codex case forces a fake binary through LINES_CODEX_PATH, as
 * sessions.codex.test.ts does; node:test gives each file its own process.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-routing-'));
const FAKE_CODEX = path.join(TMP, 'codex');
fs.writeFileSync(FAKE_CODEX, '#!/bin/sh\necho "codex-cli 99.0.0"\n', { mode: 0o755 });

const claudeRule: RoutingRule = {
  rule: 'max for debugging, low for small edits',
  models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  efforts: ['low', 'high', 'max'],
};
const openaiRule: RoutingRule = { rule: 'r', models: ['gpt-5.6-terra', 'gpt-6-sol'], efforts: ['low', 'high'] };

const meta = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: 's1',
    name: 's1',
    cwd: '/tmp',
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    status: 'idle',
    createdAt: 1,
    ...over,
  }) as SessionMeta;

interface HarnessOptions {
  mode?: 'off' | 'auto' | 'ask';
  session?: Partial<SessionMeta>;
  workflows?: WorkflowDef[];
  codex?: boolean;
  /** Skip saving a TypeSafe key, as for a user who never entered one. */
  noKey?: boolean;
}

function harness(opts: HarnessOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-routing-store-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta(opts.session)]));
  if (opts.workflows) fs.writeFileSync(path.join(root, 'workflows.json'), JSON.stringify(opts.workflows));
  const store = createStore(root);
  const settings: UserUiSettings = {
    smartRouting: { mode: opts.mode ?? 'auto', rules: { anthropic: claudeRule, openai: openaiRule } },
  };
  store.saveSettings(settings);
  if (!opts.noKey) store.saveTypesafeKey('user-key');
  const broadcasts: ServerMessage[] = [];
  const sessions = opts.codex
    ? new SessionManager(
        store,
        new GuardAllowlist(store),
        (msg) => broadcasts.push(msg),
        { ensureFreshToken: async () => 'tok' } as unknown as AuthManager,
        new McpConnections(store),
        { isLoggedIn: () => true, getStatus: () => ({ loggedIn: true }) } as unknown as OpenaiAuthManager,
      )
    : new SessionManager(store, new GuardAllowlist(store), (msg) => broadcasts.push(msg));
  const pushes: { message: Record<string, unknown>; options: Record<string, unknown> }[] = [];
  const closes: string[] = [];
  const modelSets: string[] = [];
  sessions.attachWorker({
    push: (_id: string, message: Record<string, unknown>, options: Record<string, unknown>) =>
      pushes.push({ message, options }),
    close: (id: string) => closes.push(id),
    interrupt: () => {},
    linkOpen: true,
    setModel: (_id: string, model: string) => modelSets.push(model),
    setPermissionMode: () => {},
  } as never);
  let pick: JevDecision | null = null;
  let calls = 0;
  const rules: RoutingRule[] = [];
  const apiKeys: (string | null)[] = [];
  sessions.decideTurn = async (input) => {
    calls++;
    rules.push(input.rule);
    apiKeys.push(input.apiKey);
    // The real decideTurn's contract: no key, no call, no answer.
    return input.apiKey ? pick : null;
  };
  const workflows = opts.workflows ? new WorkflowEngine(store, sessions, () => {}, 'u1') : undefined;
  return {
    sessions,
    store,
    workflows,
    pushes,
    closes,
    modelSets,
    broadcasts,
    rules,
    apiKeys,
    setPick: (p: JevDecision | null) => (pick = p),
    calls: () => calls,
    s1: () => sessions.get('s1')!,
  };
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** First turn done and idle, so closes after it say something (see sessions.effort.test.ts). */
async function firstTurn(h: ReturnType<typeof harness>) {
  h.sessions.prompt('s1', 'first');
  await settle();
  h.sessions.setStatus('s1', 'idle');
  return h.closes.length;
}

test('auto applies the pick and recycles the query exactly once, on the same push', async () => {
  const h = harness();
  const baseline = await firstTurn(h);
  h.setPick({ effort: { level: 'max', confidence: 0.9 }, model: { id: 'claude-sonnet-5-5', confidence: 0.9 } });

  h.sessions.prompt('s1', 'why does this deadlock?');
  await settle();

  assert.equal(h.s1().reasoningEffort, 'max');
  assert.equal(h.s1().model, 'claude-sonnet-5-5');
  assert.deepEqual(h.modelSets, ['claude-sonnet-5-5']);
  assert.equal(h.pushes.at(-1)!.options.effort, 'max');
  assert.equal(h.closes.length, baseline + 1);
  assert.equal(h.s1().lastRouting?.effort, 'max');
  // Routing's own change never pauses routing.
  assert.equal(h.s1().routingPaused, undefined);

  // The same pick again is a no-op: no recycle.
  h.sessions.setStatus('s1', 'idle');
  h.sessions.prompt('s1', 'and again');
  await settle();
  assert.equal(h.closes.length, baseline + 1);
});

test('no answer pushes unchanged', async () => {
  const h = harness({ session: { reasoningEffort: 'high' } });
  const baseline = await firstTurn(h);
  h.setPick(null);
  h.sessions.prompt('s1', 'x');
  await settle();
  assert.equal(h.pushes.length, 2);
  assert.equal(h.s1().reasoningEffort, 'high');
  assert.equal(h.closes.length, baseline);
  assert.equal(h.s1().lastRouting, undefined);
});

test("JEV is asked with the user's stored key", async () => {
  const h = harness();
  h.sessions.prompt('s1', 'x');
  await settle();
  assert.deepEqual(h.apiKeys, ['user-key']);
});

test('with no stored key the turn pushes unchanged', async () => {
  const h = harness({ noKey: true, session: { reasoningEffort: 'high' } });
  h.setPick({ effort: { level: 'max', confidence: 1 } });
  h.sessions.prompt('s1', 'x');
  await settle();
  assert.deepEqual(h.apiKeys, [null]);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0]!.options.effort, 'high');
  assert.equal(h.s1().lastRouting, undefined);
});

test('a key saved later applies on the next turn', async () => {
  const h = harness({ noKey: true });
  await firstTurn(h);
  h.store.saveTypesafeKey('fresh');
  h.sessions.prompt('s1', 'x');
  await settle();
  assert.deepEqual(h.apiKeys, [null, 'fresh']);
});

test('mode off never calls JEV', async () => {
  const h = harness({ mode: 'off' });
  h.sessions.prompt('s1', 'x');
  await settle();
  assert.equal(h.calls(), 0);
  assert.equal(h.pushes.length, 1);
});

test('plan mode is not routed, so the plan-mode effort keeps winning', async () => {
  const h = harness({ session: { permissionMode: 'plan' } });
  h.store.saveSettings({ ...h.store.loadSettings()!, planReasoningEffort: 'xhigh' });
  h.setPick({ effort: { level: 'low', confidence: 1 } });
  h.sessions.prompt('s1', 'plan it');
  await settle();
  assert.equal(h.calls(), 0);
  assert.equal(h.pushes[0]!.options.effort, 'xhigh');
});

test('an interjection into the live turn skips JEV', async () => {
  const h = harness();
  h.sessions.prompt('s1', 'first');
  await settle();
  const before = h.calls();
  // Queue a prompt while running, then release it into the live turn.
  h.sessions.userPrompt('s1', 'meanwhile', [], [], { queue: true });
  const queued = h.s1().queued?.[0];
  assert.ok(queued, 'queued behind the running turn');
  h.sessions.interjectQueued('s1', queued.id, { needsApproval: false });
  await settle();
  assert.equal(h.calls(), before);
});

test('ask holds the turn; accept switches and sends', async () => {
  const h = harness({ mode: 'ask' });
  h.setPick({ effort: { level: 'low', confidence: 0.86 }, model: { id: 'claude-sonnet-5-5', confidence: 0.9 } });
  h.sessions.prompt('s1', 'rename this');
  await settle();
  assert.equal(h.pushes.length, 0);
  assert.equal(h.s1().status, 'running');
  assert.deepEqual(
    { model: h.s1().routingSuggestion?.model, effort: h.s1().routingSuggestion?.effort },
    { model: 'claude-sonnet-5-5', effort: 'low' },
  );

  h.sessions.routingChoice('s1', true);
  await settle();
  assert.equal(h.pushes.length, 1);
  assert.equal(h.s1().model, 'claude-sonnet-5-5');
  assert.equal(h.pushes[0]!.options.effort, 'low');
  assert.equal(h.s1().routingSuggestion, undefined);
});

test('ask: decline sends unchanged', async () => {
  const h = harness({ mode: 'ask', session: { reasoningEffort: 'high' } });
  h.setPick({ effort: { level: 'low', confidence: 0.9 } });
  h.sessions.prompt('s1', 'x');
  await settle();
  h.sessions.routingChoice('s1', false);
  await settle();
  assert.equal(h.pushes.length, 1);
  assert.equal(h.s1().reasoningEffort, 'high');
  assert.equal(h.s1().routingSuggestion, undefined);
  // Released without routing: JEV is asked once per turn, not again on release.
  assert.equal(h.calls(), 1);
});

test('ask: interrupt drops the held turn and settles it with a Retry', async () => {
  const h = harness({ mode: 'ask' });
  h.setPick({ effort: { level: 'low', confidence: 0.9 } });
  h.sessions.prompt('s1', 'x');
  await settle();
  h.sessions.interrupt('s1');
  await settle();
  assert.equal(h.pushes.length, 0);
  assert.equal(h.s1().routingSuggestion, undefined);
  assert.equal(h.s1().status, 'error');
  // A late answer finds nothing to send.
  h.sessions.routingChoice('s1', true);
  await settle();
  assert.equal(h.pushes.length, 0);
});

test('ask: a prompt sent during the hold queues behind it', async () => {
  const h = harness({ mode: 'ask' });
  h.setPick({ effort: { level: 'low', confidence: 0.9 } });
  h.sessions.prompt('s1', 'x');
  await settle();
  h.sessions.userPrompt('s1', 'second');
  assert.equal(h.s1().queued?.length, 1);
  assert.equal(h.pushes.length, 0);
});

test('reconcile after a restart clears an orphaned suggestion and demotes the turn', async () => {
  // A suggestion on disk with no held turn in this process = a bridge restart.
  const h = harness({
    mode: 'ask',
    session: {
      status: 'running',
      turnSource: 'user',
      routingSuggestion: { model: 'claude-sonnet-5-5', effort: 'low', confidence: 0.9, at: 1 },
    },
  });
  // Make the session count as run here (a local transcript).
  h.sessions.emitEvent('s1', 'user', { text: 'x', source: 'user' });
  h.sessions.reconcileWithWorker([], { autoContinue: false });
  assert.equal(h.s1().routingSuggestion, undefined);
  assert.notEqual(h.s1().status, 'running');
  assert.ok(h.s1().interruptedAt, 'Continue/Retry banner flagged');
});

test('a manual change pauses routing only while routing is on', () => {
  const on = harness();
  on.sessions.pauseRoutingForManualChange('s1');
  assert.equal(on.s1().routingPaused, true);
  on.sessions.setRoutingPaused('s1', false);
  assert.equal(on.s1().routingPaused, undefined);

  const off = harness({ mode: 'off' });
  off.sessions.pauseRoutingForManualChange('s1');
  assert.equal(off.s1().routingPaused, undefined);
});

test('a paused session is not routed', async () => {
  const h = harness({ session: { routingPaused: true } });
  h.sessions.prompt('s1', 'x');
  await settle();
  assert.equal(h.calls(), 0);
});

test('a codex session is routed within its own provider', async () => {
  process.env.LINES_CODEX_PATH = FAKE_CODEX;
  const { refreshCodexCli } = await import('./codexCli.ts');
  await refreshCodexCli();
  const h = harness({ codex: true, session: { model: 'gpt-5.6-terra' } });
  h.setPick({ effort: { level: 'high', confidence: 0.9 }, model: { id: 'gpt-6-sol', confidence: 0.9 } });
  h.sessions.prompt('s1', 'x');
  await settle();
  assert.deepEqual(h.rules[0], openaiRule);
  assert.equal(h.s1().model, 'gpt-6-sol');
  assert.equal(h.s1().reasoningEffort, 'high');
  assert.equal(h.pushes.length, 1);
});

test('a workflow step’s own rule overrides the global one', async () => {
  const stepRule: RoutingRule = { rule: 'step', models: ['claude-sonnet-5-5', 'claude-haiku-4-5'], efforts: ['low', 'medium'] };
  const wf: WorkflowDef = {
    id: 'wf1',
    name: 'routed',
    steps: [
      {
        name: 'Step 1',
        promptTemplate: 'do it',
        model: 'claude-sonnet-5-5',
        permissionMode: 'default',
        autoAdvance: false,
        freshStart: false,
        routing: stepRule,
      },
    ],
  };
  const h = harness({
    workflows: [wf],
    session: {
      model: 'claude-sonnet-5-5',
      workflow: { workflowId: 'wf1', started: true, stepIndex: 0, stepStatuses: ['running'] },
    },
  });
  h.sessions.prompt('s1', 'x', 'workflow');
  await settle();
  assert.deepEqual(h.rules[0], stepRule);
});
