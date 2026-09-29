import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage, SessionMeta, TranscriptEvent, WorkflowState } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { refreshClaudeCli } from './claudeCli.ts';
import { refreshCodexCli } from './codexCli.ts';
import type { OpenaiAuthManager } from './openaiAuth.ts';
import { SessionManager, withoutProviderSwitchSpans } from './sessions.ts';
import { createStore } from './store.ts';
import type { WorkerClient } from './workerClient.ts';

/**
 * The deliberate way past `setModel`'s cross-provider refusal.
 *
 * The property under test is ordering, not policy: every refusal has to happen
 * before anything destructive, because the destructive step (resetClaudeSession)
 * drops the only conversation the session has. A refusal that lands after it
 * costs the user their work and gives them nothing — so each block below is
 * asserted to be *atomic*, model and resume pointers untouched.
 */

/**
 * Both CLIs, faked. `LINES_CLAUDE_PATH` / `LINES_CODEX_PATH` are exclusive (see
 * claudeCli.ts, codexCli.ts), so this decides the probe's answer regardless of
 * what the machine running the suite has installed — the switch now refuses on a
 * missing CLI, which would otherwise make every case here depend on the laptop.
 * node:test gives each file its own process, so the env stays local.
 */
const CLI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-switch-cli-'));
const fakeCli = (name: string, version: string) => {
  const binary = path.join(CLI_DIR, name);
  fs.writeFileSync(binary, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  return binary;
};
process.env.LINES_CLAUDE_PATH = fakeCli('claude', '9.9.9 (Claude Code)');
process.env.LINES_CODEX_PATH = fakeCli('codex', 'codex-cli 99.0.0');
refreshClaudeCli();
refreshCodexCli();

interface HarnessOptions {
  /** Seeded onto the session before the switch. */
  model?: string;
  openaiConnected?: boolean;
  workflow?: WorkflowState;
  queued?: { id: string; ts: number; text: string }[];
  status?: SessionMeta['status'];
  /** false = the worker never answers the stop, so the turn never settles. */
  workerStops?: boolean;
}

const ev = (seq: number, kind: TranscriptEvent['kind'], data: unknown): TranscriptEvent =>
  ({ seq, ts: seq, kind, data }) as TranscriptEvent;

function harness(opts: HarnessOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-switch-provider-'));
  const session = {
    id: 's1',
    name: 's1',
    cwd: '/tmp',
    model: opts.model ?? 'claude-sonnet-5-5',
    permissionMode: 'default',
    status: opts.status ?? 'idle',
    createdAt: 1,
    // The conversation the switch has to drop — and that every refusal has to keep.
    claudeSessionId: 'claude-abc',
    ...(opts.workflow ? { workflow: opts.workflow } : {}),
    ...(opts.queued ? { queued: opts.queued } : {}),
  } as SessionMeta;
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([session]));

  const store = createStore(root);
  const openaiAuth = {
    isLoggedIn: () => opts.openaiConnected !== false,
    getStatus: () => ({ loggedIn: opts.openaiConnected !== false }),
  } as unknown as OpenaiAuthManager;

  const broadcasts: ServerMessage[] = [];
  const sessions = new SessionManager(
    store,
    new GuardAllowlist(store),
    (msg) => broadcasts.push(msg),
    undefined,
    undefined,
    openaiAuth,
  );
  const closed: string[] = [];
  const interrupts: string[] = [];
  sessions.attachWorker({
    push: () => {},
    // A real worker answers a stop with the turn's `result`, which is what clears
    // `interrupting` and settles the turn. `workerStops: false` is the CLI that
    // never answers.
    interrupt: (id: string) => {
      interrupts.push(id);
      if (opts.workerStops === false) return;
      setTimeout(() => sessions.handleWorkerEvent(id, { type: 'result', subtype: 'success' }), 0);
    },
    close: (id: string) => closed.push(id),
    setModel: () => {},
    setPermissionMode: () => {},
    linkOpen: true,
  } as unknown as WorkerClient);

  const prompts: string[] = [];
  const realPrompt = sessions.prompt.bind(sessions);
  sessions.prompt = ((id: string, text: string, ...rest: unknown[]) => {
    prompts.push(text);
    return realPrompt(id, text, ...(rest as []));
  }) as typeof sessions.prompt;

  // A real conversation on disk, so collectTurns has turns to summarize and
  // lastAssistantText has something to fall back to.
  store.appendTranscript('s1', ev(0, 'user', { text: 'read config.ts and remember the port' }));
  store.appendTranscript(
    's1',
    ev(1, 'sdk', {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'the port is 8123' }] },
    }),
  );

  /** The summary query, stubbed: the real one spawns a CLI. */
  const stubSummary = (answer: string | null | Promise<string | null>) => {
    (sessions as unknown as { handoffQuery: () => Promise<string | null> }).handoffQuery = () =>
      Promise.resolve(answer) as Promise<string | null>;
  };
  stubSummary('PORT IS 8123, work continues');

  return {
    sessions,
    store,
    prompts,
    closed,
    interrupts,
    broadcasts,
    stubSummary,
    s1: () => sessions.get('s1')!,
  };
}

/** Transcript kinds the switch wrote, in order. */
const kinds = (h: ReturnType<typeof harness>) =>
  h.store.loadTranscript('s1').map((e) => e.kind);

test('a cross-provider switch drops the conversation and seeds the new one', async () => {
  const h = harness();
  const verdict = await h.sessions.switchProvider('s1', 'gpt-5.6-terra');
  assert.equal(verdict.ok, true, verdict.ok === false ? verdict.reason : '');

  const m = h.s1();
  assert.equal(m.model, 'gpt-5.6-terra');
  // Both pointers, not just the one this session had: neither conversation may
  // be resumed under the new provider.
  assert.equal(m.claudeSessionId, undefined);
  assert.equal(m.codexThreadId, undefined);
  assert.equal(h.prompts.length, 1, 'exactly one seed prompt');
  assert.match(h.prompts[0]!, /PORT IS 8123/);
  // The durable record that everything above the line is invisible below it.
  assert.ok(kinds(h).includes('provider-switch'));
  const marker = h.store
    .loadTranscript('s1')
    .find((e) => e.kind === 'provider-switch')!.data as Record<string, unknown>;
  assert.deepEqual(marker, {
    from: 'claude-sonnet-5-5',
    to: 'gpt-5.6-terra',
    summarized: true,
    // The conversation being left behind, recorded because the reset below is
    // about to make it unnameable — a rewind above this marker restores it.
    fromSessionId: 'claude-abc',
  });
});

test('a running turn is stopped, then switched', async () => {
  const h = harness({ status: 'running' });
  const verdict = await h.sessions.switchProvider('s1', 'gpt-5.6-terra');

  assert.equal(verdict.ok, true, verdict.ok === false ? verdict.reason : '');
  assert.deepEqual(h.interrupts, ['s1'], 'stopped once, not per poll');
  assert.equal(h.s1().model, 'gpt-5.6-terra');
  assert.equal(h.s1().claudeSessionId, undefined);
  assert.equal(h.prompts.length, 1);
});

test('a stop the worker never answers refuses, atomically', async () => {
  const h = harness({ status: 'running', workerStops: false });
  h.sessions.interruptSettleMs = 40;
  const verdict = await h.sessions.switchProvider('s1', 'gpt-5.6-terra');

  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false ? verdict.code : '', 'turn-running');
  assert.equal(h.s1().model, 'claude-sonnet-5-5');
  assert.equal(h.s1().claudeSessionId, 'claude-abc', 'the conversation survived the refusal');
  assert.equal(h.prompts.length, 0);
});

test('a parked workflow step switches, and flags the next step', async () => {
  const h = harness({
    status: 'waiting-approval',
    workflow: {
      workflowId: 'wf1',
      started: true,
      stepIndex: 0,
      stepStatuses: ['waiting-approval', 'pending'],
    },
  });
  const verdict = await h.sessions.switchProvider('s1', 'gpt-5.6-terra');

  assert.equal(verdict.ok, true, verdict.ok === false ? verdict.reason : '');
  const m = h.s1();
  assert.equal(m.model, 'gpt-5.6-terra');
  assert.equal(m.claudeSessionId, undefined);
  assert.equal(h.prompts.length, 1);
  // What stops the next inheriting step parking as a pre-run failure.
  assert.equal(m.workflow?.providerSwitched, true);
  // The step itself is untouched — the switch is not an approval.
  assert.equal(m.workflow?.stepIndex, 0);
  assert.equal(m.workflow?.stepStatuses[0], 'waiting-approval');
});

test('a finished workflow session switches like any other', async () => {
  // meta.workflow is never cleared, so "finished" is the common shape a blanket
  // workflow refusal used to make permanently unswitchable.
  const h = harness({
    workflow: { workflowId: 'wf1', started: true, stepIndex: 1, stepStatuses: ['done', 'done'] },
  });
  const verdict = await h.sessions.switchProvider('s1', 'gpt-5.6-terra');

  assert.equal(verdict.ok, true, verdict.ok === false ? verdict.reason : '');
  assert.equal(h.s1().model, 'gpt-5.6-terra');
});

test('a step still marked running after the settle refuses, atomically', async () => {
  // The one shape where the seed turn could be mistaken for the step's own turn:
  // onWorkflowTurnComplete only ignores a step that is *not* running.
  const h = harness({
    workflow: { workflowId: 'wf1', started: true, stepIndex: 0, stepStatuses: ['running'] },
  });
  const verdict = await h.sessions.switchProvider('s1', 'gpt-5.6-terra');

  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false ? verdict.code : '', 'turn-running');
  assert.equal(h.s1().claudeSessionId, 'claude-abc');
  assert.equal(h.prompts.length, 0);
});

test('an advance in flight refuses the switch, atomically', async () => {
  const h = harness({
    workflow: { workflowId: 'wf1', started: true, stepIndex: 0, stepStatuses: ['done', 'pending'] },
  });
  // Set on the live meta, not in the stored file: an advance is in-flight state,
  // and SessionManager's constructor clears a persisted one by design.
  h.s1().workflow!.advancing = true;
  const verdict = await h.sessions.switchProvider('s1', 'gpt-5.6-terra');

  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false ? verdict.code : '', 'step-advancing');
  assert.equal(h.s1().claudeSessionId, 'claude-abc');
});

test('a pending advance refuses the switch, atomically', async () => {
  const h = harness({
    status: 'running',
    workflow: {
      workflowId: 'wf1',
      started: true,
      stepIndex: 0,
      stepStatuses: ['running'],
      advanceOnComplete: 'interrupted',
      advanceOnCompleteStep: 0,
    },
  });
  const verdict = await h.sessions.switchProvider('s1', 'gpt-5.6-terra');

  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false ? verdict.code : '', 'advance-pending');
  // Refused before the stop: a force-advance already owns this turn.
  assert.equal(h.interrupts.length, 0);
  assert.equal(h.s1().claudeSessionId, 'claude-abc');
});

test('queued prompts refuse the switch, atomically', async () => {
  const h = harness({ queued: [{ id: 'q1', ts: 1, text: 'and then deploy it' }] });
  const verdict = await h.sessions.switchProvider('s1', 'gpt-5.6-terra');

  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false ? verdict.code : '', 'queued');
  assert.equal(h.s1().model, 'claude-sonnet-5-5');
  assert.equal(h.s1().claudeSessionId, 'claude-abc');
  assert.equal(h.s1().queued?.length, 1);
});

test('a missing target CLI refuses *before* the conversation is dropped', async () => {
  // The sibling of the account check, and the same data-loss shape: an account
  // that is connected but a `codex` that is not installed fails the first turn
  // exactly the same way — harmless before the reset, total loss after it.
  const h = harness();
  process.env.LINES_CODEX_PATH = path.join(CLI_DIR, 'not-installed');
  refreshCodexCli();
  try {
    const verdict = await h.sessions.switchProvider('s1', 'gpt-5.6-terra');

    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false ? verdict.code : '', 'cli-missing');
    assert.match(verdict.ok === false ? verdict.reason : '', /not installed/);
    assert.equal(h.s1().claudeSessionId, 'claude-abc', 'the conversation survived the refusal');
    assert.equal(h.s1().model, 'claude-sonnet-5-5');
    assert.equal(h.closed.length, 0, 'and its worker was never closed');
    assert.equal(h.prompts.length, 0);
  } finally {
    process.env.LINES_CODEX_PATH = path.join(CLI_DIR, 'codex');
    refreshCodexCli();
  }
});

test('no OpenAI account refuses *before* the conversation is dropped', async () => {
  // The regression that would silently destroy user data: today a disconnected
  // account merely fails the first turn, which is harmless — after a reset it
  // would mean the conversation is gone and nothing ran.
  const h = harness({ openaiConnected: false });
  const verdict = await h.sessions.switchProvider('s1', 'gpt-5.6-terra');

  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false ? verdict.code : '', 'not-connected');
  assert.equal(h.s1().claudeSessionId, 'claude-abc', 'the conversation survived the refusal');
  assert.equal(h.s1().model, 'claude-sonnet-5-5');
  assert.equal(h.closed.length, 0, 'and its worker was never closed');
});

test('a summary the helper cannot produce still completes the switch', async () => {
  const h = harness();
  h.stubSummary(null);
  const verdict = await h.sessions.switchProvider('s1', 'gpt-5.6-terra');

  assert.equal(verdict.ok, true);
  assert.equal(h.s1().model, 'gpt-5.6-terra');
  // Seeded from lastAssistantText instead.
  assert.match(h.prompts[0]!, /the port is 8123/);
  const marker = h.store
    .loadTranscript('s1')
    .find((e) => e.kind === 'provider-switch')!.data as { summarized: boolean };
  assert.equal(marker.summarized, false, 'and the transcript says the summary fell back');
});

test('a summary that hangs still completes the switch', async () => {
  const h = harness();
  h.sessions.switchSummaryTimeoutMs = 5;
  // Never resolves — the timeout is the only way out.
  (h.sessions as unknown as { handoffQuery: () => Promise<string | null> }).handoffQuery = () =>
    new Promise(() => {});
  const verdict = await h.sessions.switchProvider('s1', 'gpt-5.6-terra');

  assert.equal(verdict.ok, true);
  assert.equal(h.s1().model, 'gpt-5.6-terra');
  assert.equal(h.prompts.length, 1);
});

test('a second switch is refused by the guard, not run twice', async () => {
  const h = harness();
  let release: (v: string) => void = () => {};
  (h.sessions as unknown as { handoffQuery: () => Promise<string | null> }).handoffQuery = () =>
    new Promise<string>((r) => (release = r));

  const first = h.sessions.switchProvider('s1', 'gpt-5.6-terra');
  const second = await h.sessions.switchProvider('s1', 'gpt-5.6-terra');
  assert.equal(second.ok, false);
  assert.equal(second.ok === false ? second.code : '', 'switching');

  release('summary');
  assert.equal((await first).ok, true);
  assert.equal(h.prompts.length, 1, 'one switch, one seed prompt');
});

test('a prompt sent while the switch runs waits for it', async () => {
  // The window the guard exists for: the summary query is awaited with the
  // session's status still idle, so nothing else says it is busy.
  const h = harness();
  let release: (v: string) => void = () => {};
  (h.sessions as unknown as { handoffQuery: () => Promise<string | null> }).handoffQuery = () =>
    new Promise<string>((r) => (release = r));

  const switching = h.sessions.switchProvider('s1', 'gpt-5.6-terra');
  h.sessions.userPrompt('s1', 'one more thing');
  assert.equal(h.prompts.length, 0, 'queued, not raced into the old conversation');
  assert.equal(h.s1().queued?.length, 1);

  release('summary');
  await switching;
  assert.equal(h.prompts.length, 1, 'only the seed ran');
  assert.match(h.prompts[0]!, /summary/);
});

test('a same-provider switchProvider is just a setModel', async () => {
  const h = harness();
  const verdict = await h.sessions.switchProvider('s1', 'claude-opus-5-5');

  assert.equal(verdict.ok, true);
  assert.equal(h.s1().model, 'claude-opus-5-5');
  assert.equal(h.s1().claudeSessionId, 'claude-abc', 'nothing to drop, so nothing dropped');
  assert.equal(h.prompts.length, 0, 'and no hand-off turn');
  assert.ok(!kinds(h).includes('provider-switch'));
});

test('a guest without the setModel cap is refused, atomically', async () => {
  const h = harness();
  const verdict = await h.sessions.switchProvider('s1', 'gpt-5.6-terra', { canSetModel: false });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false ? verdict.code : '', 'denied');
  assert.equal(h.s1().claudeSessionId, 'claude-abc');
});

// ---------------------------------------------------------------------------
// withoutProviderSwitchSpans — the hand-off turn is bookkeeping, not an attempt
// ---------------------------------------------------------------------------

const assistant = (text: string) =>
  ev(0, 'sdk', { type: 'assistant', message: { content: [{ type: 'text', text }] } });
const marker = () => ev(0, 'provider-switch', { from: 'a', to: 'b', summarized: true });

test('a switch marker, its seed prompt and that turn are removed', () => {
  const events = [
    ev(0, 'user', { text: 'do the work' }),
    assistant('draft one'),
    marker(),
    ev(0, 'user', { text: '## Context from the previous model…' }),
    assistant('understood, the port is 8123'),
    ev(0, 'user', { text: 'now tighten it' }),
    assistant('tightened'),
  ];
  assert.deepEqual(
    withoutProviderSwitchSpans(events).map((e) => (e.data as { text?: string }).text ?? 'sdk'),
    ['do the work', 'sdk', 'now tighten it', 'sdk'],
  );
});

test('a step marker closes the span, so the next step is never swallowed', () => {
  const events = [
    marker(),
    ev(0, 'user', { text: 'handoff' }),
    assistant('understood'),
    ev(0, 'workflow', { stepIndex: 1, stepName: 'Step 2', event: 'started' }),
    ev(0, 'user', { text: 'do step 2' }),
  ];
  assert.deepEqual(
    withoutProviderSwitchSpans(events).map((e) => e.kind),
    ['workflow', 'user'],
  );
});

test('a marker with no seed after it swallows nothing', () => {
  // The bridge died between the marker and the prompt. One crash must not hide
  // the rest of the transcript forever.
  const events = [marker(), assistant('late output'), ev(0, 'user', { text: 'next' })];
  assert.deepEqual(
    withoutProviderSwitchSpans(events).map((e) => e.kind),
    ['sdk', 'user'],
  );
});

test('a step whose slice holds a hand-off keeps its own output', async () => {
  // The corruption this strip prevents: the acknowledgement becoming the step's
  // deliverable, and from there the {previous} hand-off to the next step.
  const h = harness();
  h.store.appendTranscript('s1', ev(2, 'workflow', { stepIndex: 0, stepName: 'Step 1', event: 'started' }));
  h.store.appendTranscript('s1', ev(3, 'user', { text: 'do step 1' }));
  h.store.appendTranscript('s1', ev(4, 'sdk', {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'the step deliverable' }] },
  }));
  h.store.appendTranscript('s1', ev(5, 'provider-switch', { from: 'a', to: 'b', summarized: true }));
  h.store.appendTranscript('s1', ev(6, 'user', { text: '## Context from the previous model…' }));
  h.store.appendTranscript('s1', ev(7, 'sdk', {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'understood, standing by' }] },
  }));

  assert.equal(await h.sessions.consolidateStepOutput('s1', 0), 'the step deliverable');
});

test('a guest whose prompts need approval cannot inject the seed turn', async () => {
  // The seed goes through prompt(), which bypasses userPrompt's approval staging
  // — so the refusal has to be here rather than in the queue.
  const h = harness();
  const verdict = await h.sessions.switchProvider('s1', 'gpt-5.6-terra', { needsApproval: true });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false ? verdict.code : '', 'denied');
  assert.equal(h.s1().claudeSessionId, 'claude-abc');
  assert.equal(h.prompts.length, 0);
});
