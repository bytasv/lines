import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SessionMeta, TranscriptEvent, WorkflowState } from '@lines/shared';
import { rewindBlock } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import type { WorkerClient } from './workerClient.ts';

const meta = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: 's',
    name: 'n',
    cwd: '/tmp/project',
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    status: 'idle',
    createdAt: 1,
    claudeSessionId: 'cli-1',
    totalCostUsd: 1.25,
    totalTokens: 4200,
    ...over,
  }) as SessionMeta;

const ev = (seq: number, kind: TranscriptEvent['kind'], data: unknown): TranscriptEvent => ({
  seq,
  ts: seq,
  kind,
  data,
});

const assistant = (seq: number, uuid: string | undefined, text: string) =>
  ev(seq, 'sdk', { type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } });

/**
 * Two prompts, each answered. Seq 2 is the rewind target and seq 1 is the
 * assistant message a fork must anchor on.
 */
const TRANSCRIPT: TranscriptEvent[] = [
  ev(0, 'user', { text: 'first' }),
  assistant(1, 'uuid-1', 'answer one'),
  ev(2, 'user', { text: 'second, the oversized one' }),
  assistant(3, 'uuid-2', 'answer two'),
  ev(4, 'sdk', { type: 'result', subtype: 'success', result: 'answer two' }),
];

/** A SessionManager over a throwaway store, seeded with TRANSCRIPT. */
function harness(over: Partial<SessionMeta> = {}, events: TranscriptEvent[] = TRANSCRIPT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-rewind-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta(over)]));
  fs.mkdirSync(path.join(root, 'transcripts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'transcripts', 's.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  const store = createStore(root);
  const sent: string[] = [];
  const sessions = new SessionManager(store, new GuardAllowlist(store), (msg) => sent.push(msg.type));
  const closed: string[] = [];
  sessions.attachWorker({
    push: () => {},
    close: (id: string) => closed.push(id),
    interrupt: () => {},
    // Reached only when a rewind moves the model — i.e. one that crosses a
    // provider switch (see restoreEra).
    setModel: () => {},
  } as unknown as WorkerClient);
  const forks: { sessionId: string; upToMessageId?: string; dir?: string }[] = [];
  sessions.forkSession = async (sessionId, opts) => {
    forks.push({ sessionId, upToMessageId: opts?.upToMessageId, dir: opts?.dir });
    return { sessionId: 'cli-2' };
  };
  return { sessions, store, root, forks, closed, sent };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('rewindBlock names a reason for every state it refuses', () => {
  const cases: [Partial<SessionMeta>, string][] = [
    [{ status: 'running' }, 'turn-running'],
    [{ status: 'waiting-permission' }, 'turn-running'],
    [{ claudeSessionId: undefined }, 'no-session'],
  ];
  for (const [over, code] of cases) {
    const block = rewindBlock(meta(over));
    assert.equal(block?.code, code);
    assert.ok(block && block.reason.length > 0, `${code} must carry a tooltip reason`);
  }
});

test('an idle session with a CLI conversation is rewindable', () => {
  assert.equal(rewindBlock(meta()), null);
});

/** Only a *live* turn blocks. A settled-but-not-idle session reporting "finish the
 *  current turn first" is what made the affordance read as permanently broken. */
test('a settled session is rewindable whatever its badge says', () => {
  for (const status of ['idle', 'done', 'error', 'waiting-approval'] as const) {
    assert.equal(rewindBlock(meta({ status })), null, status);
  }
});

/** Changing your mind halfway through a workflow is a main reason to rewind; the
 *  engine rolls its own step bookkeeping back (see workflows.rewind.test.ts). */
test('a workflow session is rewindable, started or not', () => {
  for (const started of [true, false]) {
    assert.equal(
      rewindBlock(meta({ workflow: { started } as unknown as WorkflowState })),
      null,
      `started=${started}`,
    );
  }
});

test('a busy session is refused and nothing is forked', async () => {
  const { sessions, forks } = harness({ status: 'running' });
  const result = await sessions.rewindSession('s', 2);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, 'turn-running');
  assert.deepEqual(forks, []);
});

test('a session that never ran a turn is refused', async () => {
  const { sessions } = harness({ claudeSessionId: undefined });
  const result = await sessions.rewindSession('s', 2);
  assert.equal(!result.ok && result.code, 'no-session');
});

/** With no listener wired (a plain SessionManager, as in these tests) the session
 *  settles itself; the workflow rollback is covered in workflows.rewind.test.ts. */
test('a rewind listener may settle the session instead of idling it', async () => {
  const { sessions } = harness();
  let sawSessionId = '';
  sessions.setRewindListener((id) => {
    sawSessionId = id;
    sessions.setStatus(id, 'waiting-approval');
    return true;
  });
  assert.equal((await sessions.rewindSession('s', 2)).ok, true);
  assert.equal(sawSessionId, 's');
  assert.equal(sessions.get('s')!.status, 'waiting-approval', 'idle must not clobber the park');
  // The reset bookkeeping still lands, via persistMeta rather than setStatus.
  assert.ok(sessions.get('s')!.contextResetAt! > 0);
});

/** The listener runs after the truncation is on the wire, so events it emits are
 *  not swept up by the client's "drop everything at or after seq" filter. */
test('the truncation is broadcast before the listener can emit', async () => {
  const { sessions, sent } = harness();
  sessions.setRewindListener((id) => {
    sessions.emitEvent(id, 'workflow', { stepIndex: 0, stepName: 's', event: 'waiting-approval' });
    return false;
  });
  await sessions.rewindSession('s', 2);
  const order = sent;
  const truncated = order.indexOf('transcriptTruncated');
  assert.ok(truncated >= 0, 'the truncation must be broadcast by rewindSession itself');
  assert.ok(order.indexOf('event', truncated) > truncated, 'listener events must follow it');
});

test('a seq that is not a user event is refused, transcript untouched', async () => {
  const { sessions, store, forks } = harness();
  for (const seq of [1, 4, 99]) {
    const result = await sessions.rewindSession('s', seq);
    assert.equal(!result.ok && result.code, 'no-message', `seq ${seq}`);
  }
  assert.equal(store.loadTranscript('s').length, TRANSCRIPT.length);
  assert.deepEqual(forks, []);
});

// ---------------------------------------------------------------------------
// Anchor resolution
// ---------------------------------------------------------------------------

test('the fork anchors on the nearest preceding assistant uuid', async () => {
  const { sessions, forks } = harness();
  const result = await sessions.rewindSession('s', 2);
  assert.equal(result.ok, true);
  assert.deepEqual(forks, [{ sessionId: 'cli-1', upToMessageId: 'uuid-1', dir: '/tmp/project' }]);
  assert.equal(sessions.get('s')!.claudeSessionId, 'cli-2');
});

/** A non-assistant SDK message (or one with no uuid) is not an anchor — the scan
 *  keeps walking back to the assistant message that has one. */
test('uuid-less and non-assistant events are skipped by the anchor scan', async () => {
  const { sessions, forks } = harness({}, [
    ev(0, 'user', { text: 'first' }),
    assistant(1, 'uuid-1', 'answer one'),
    ev(2, 'sdk', { type: 'system', subtype: 'status', uuid: 'uuid-sys' }),
    assistant(3, undefined, 'streamed fragment'),
    ev(4, 'user', { text: 'second' }),
  ]);
  const result = await sessions.rewindSession('s', 4);
  assert.equal(result.ok, true);
  assert.equal(forks[0].upToMessageId, 'uuid-1');
});

test('rewinding to the first prompt degrades to a full reset', async () => {
  const { sessions, forks, closed, store } = harness();
  const result = await sessions.rewindSession('s', 0);
  assert.equal(result.ok, true);
  assert.deepEqual(forks, [], 'nothing to fork: there is no earlier reply');
  assert.equal(sessions.get('s')!.claudeSessionId, undefined);
  assert.ok(closed.includes('s'), 'the query is dropped so the next prompt starts fresh');
  assert.equal(store.loadTranscript('s').length, 0);
});

// ---------------------------------------------------------------------------
// Ordering: fork first, so a failure costs nothing
// ---------------------------------------------------------------------------

test('a fork failure aborts before any transcript mutation', async () => {
  const { sessions, store } = harness();
  sessions.forkSession = async () => {
    throw new Error('no such session file');
  };
  const result = await sessions.rewindSession('s', 2);
  assert.equal(!result.ok && result.code, 'fork-failed');
  assert.match(!result.ok ? result.reason : '', /no such session file/);
  assert.equal(store.loadTranscript('s').length, TRANSCRIPT.length);
  assert.equal(sessions.get('s')!.claudeSessionId, 'cli-1');
});

test('a second rewind cannot race past the gate while the first is forking', async () => {
  const { sessions } = harness();
  let release: () => void = () => {};
  sessions.forkSession = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { sessionId: 'cli-2' };
  };
  const first = sessions.rewindSession('s', 2);
  const second = await sessions.rewindSession('s', 2);
  assert.equal(second.ok, false, 'the second request must not fork off a stale id');
  release();
  assert.equal((await first).ok, true);
});

// ---------------------------------------------------------------------------
// The successful path
// ---------------------------------------------------------------------------

test('a rewind truncates the transcript from the rewound message on', async () => {
  const { sessions, store } = harness();
  await sessions.rewindSession('s', 2);
  assert.deepEqual(
    store.loadTranscript('s').map((e) => e.seq),
    [0, 1],
  );
});

test('the next event resumes the numbering where the discarded tail began', async () => {
  const { sessions, store } = harness();
  await sessions.rewindSession('s', 2);
  assert.equal(sessions.emitEvent('s', 'user', { text: 'second, trimmed' }), 2);
  assert.deepEqual(
    store.loadTranscript('s').map((e) => e.seq),
    [0, 1, 2],
  );
});

test('a failed session comes back idle with its banner cleared', async () => {
  const { sessions } = harness({
    status: 'error',
    errorMessage: 'Prompt is too long',
    errorKind: 'context',
    contextCompact: { at: 1, trigger: 'manual', ok: false },
  });
  await sessions.rewindSession('s', 2);
  const after = sessions.get('s')!;
  assert.equal(after.status, 'idle');
  assert.equal(after.errorMessage, undefined);
  assert.equal(after.errorKind, undefined);
  // A new CLI conversation is a new compaction verdict.
  assert.equal(after.contextCompact, undefined);
  assert.ok(after.contextResetAt! > 0);
});

test('cumulative spend is not rewound — that money was really spent', async () => {
  const { sessions } = harness();
  await sessions.rewindSession('s', 2);
  assert.equal(sessions.get('s')!.totalCostUsd, 1.25);
  assert.equal(sessions.get('s')!.totalTokens, 4200);
});

test('an edit hands the prompt back verbatim, with no retry hint appended', async () => {
  const { sessions } = harness({ status: 'error', errorKind: 'context' });
  const result = await sessions.rewindSession('s', 2, { edit: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.prompt, {
    text: 'second, the oversized one',
    attachments: [],
  });
});

/** A plain rewind discards the message with the rest of the tail — no prompt to
 *  prefill, and (the reason the flag reaches this far) no attachment reads. */
test('a plain rewind returns no prompt and truncates the same way', async () => {
  const { sessions, store } = harness();
  const result = await sessions.rewindSession('s', 2);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.prompt, null);
  assert.deepEqual(
    store.loadTranscript('s').map((e) => e.seq),
    [0, 1],
  );
});

test('attachments are rehydrated from disk, and a missing one is dropped', async () => {
  const { sessions, root } = harness({}, [
    ev(0, 'user', { text: 'first' }),
    assistant(1, 'uuid-1', 'answer one'),
    ev(2, 'user', {
      text: 'look at these',
      mentions: [{ kind: 'file', id: '/a.ts', label: 'a.ts' }],
      attachments: [
        { name: 'a.png', mediaType: 'image/png', kind: 'image', url: '/attachments/s/kept.png' },
        { name: 'gone.png', mediaType: 'image/png', kind: 'image', url: '/attachments/s/gone.png' },
      ],
    }),
  ]);
  fs.mkdirSync(path.join(root, 'attachments', 's'), { recursive: true });
  fs.writeFileSync(path.join(root, 'attachments', 's', 'kept.png'), Buffer.from('hi'));

  const result = await sessions.rewindSession('s', 2, { edit: true });
  assert.equal(result.ok, true);
  const prompt = result.ok ? result.prompt : null;
  assert.equal(prompt!.attachments.length, 1);
  assert.equal(prompt!.attachments[0].name, 'a.png');
  assert.equal(prompt!.attachments[0].data, Buffer.from('hi').toString('base64'));
  assert.equal(prompt!.mentions?.[0].label, 'a.ts');
});

test('the discarded turns are recoverable from the sidecar', async () => {
  const { sessions, root } = harness();
  await sessions.rewindSession('s', 2);
  const dir = path.join(root, 'transcripts');
  const sidecar = fs.readdirSync(dir).find((f) => f.startsWith('s.rewind-'));
  assert.ok(sidecar, 'the dropped tail must be archived');
  const archived = fs
    .readFileSync(path.join(dir, sidecar!), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as TranscriptEvent).seq);
  assert.deepEqual(archived, [2, 3, 4]);
});

// ---------------------------------------------------------------------------
// Across a provider switch
// ---------------------------------------------------------------------------

/**
 * A session that ran on Claude, switched to codex, and ran there. Seq 0 is the
 * rewind target: a turn from the Claude era, above the switch.
 */
const SWITCHED: TranscriptEvent[] = [
  ev(0, 'user', { text: 'claude era' }),
  assistant(1, 'uuid-claude', 'answered on claude'),
  ev(2, 'user', { text: 'claude era, second turn' }),
  assistant(3, 'uuid-claude-2', 'answered again'),
  ev(4, 'provider-switch', {
    from: 'claude-opus-5-5',
    to: 'gpt-5.6-terra',
    summarized: true,
    fromSessionId: 'cli-claude',
  }),
  ev(5, 'user', { text: '## Context from the previous model…' }),
  assistant(6, 'uuid-codex', 'understood'),
  ev(7, 'sdk', { type: 'result', subtype: 'success', _codexTurnId: 'turn-codex-1' }),
  ev(8, 'user', { text: 'codex era' }),
  assistant(9, 'uuid-codex-2', 'answered on codex'),
];

test('a rewind above a switch restores the conversation and the model it left', async () => {
  const h = harness(
    { model: 'gpt-5.6-terra', claudeSessionId: undefined, codexThreadId: 'th-codex' },
    SWITCHED,
  );

  const verdict = await h.sessions.rewindSession('s', 2);
  assert.equal(verdict.ok, true, verdict.ok === false ? verdict.reason : '');

  // Forked the conversation the switch abandoned, at an anchor from that era —
  // not the one running now, which has never seen `uuid-claude`.
  assert.deepEqual(h.forks, [
    { sessionId: 'cli-claude', upToMessageId: 'uuid-claude', dir: '/tmp/project' },
  ]);
  const m = h.sessions.get('s')!;
  assert.equal(m.model, 'claude-opus-5-5', 'back on the model that era ran on');
  assert.equal(m.claudeSessionId, 'cli-2', 'and on the fork of its conversation');
  assert.equal(m.codexThreadId, undefined, 'off the codex thread entirely');
});

test('a rewind inside the codex era forks that era, naming its thread', async () => {
  const h = harness(
    { model: 'gpt-5.6-terra', claudeSessionId: undefined, codexThreadId: 'th-codex' },
    SWITCHED,
  );
  let forkedAt: { lastTurnId: string; threadId?: string } | null = null;
  h.sessions.attachWorker({
    push: () => {},
    close: () => {},
    interrupt: () => {},
    setModel: () => {},
    codexFork: async (_id: string, lastTurnId: string, threadId?: string) => {
      forkedAt = { lastTurnId, threadId };
      return 'th-forked';
    },
  } as unknown as WorkerClient);

  const verdict = await h.sessions.rewindSession('s', 8);
  assert.equal(verdict.ok, true, verdict.ok === false ? verdict.reason : '');
  assert.deepEqual(forkedAt, { lastTurnId: 'turn-codex-1', threadId: 'th-codex' });
  assert.equal(h.forks.length, 0, 'the Claude conversation is not touched');
  const m = h.sessions.get('s')!;
  assert.equal(m.model, 'gpt-5.6-terra', 'still the era it rewound inside');
  assert.equal(m.codexThreadId, 'th-forked');
});

test('an anchor is never borrowed from across the switch', async () => {
  // Target seq 5 — the hand-off turn, with no codex result settled below it. The
  // Claude era's `uuid-claude-2` sits right there in the transcript and belongs to
  // a conversation this fork would not contain.
  const h = harness(
    { model: 'gpt-5.6-terra', claudeSessionId: undefined, codexThreadId: 'th-codex' },
    SWITCHED,
  );
  let forked = false;
  h.sessions.attachWorker({
    push: () => {},
    close: () => {},
    interrupt: () => {},
    setModel: () => {},
    codexFork: async () => {
      forked = true;
      return 'th-forked';
    },
  } as unknown as WorkerClient);

  const verdict = await h.sessions.rewindSession('s', 5);
  assert.equal(verdict.ok, true, verdict.ok === false ? verdict.reason : '');
  assert.equal(forked, false, 'nothing in this era to anchor on, so nothing is forked');
  assert.equal(h.forks.length, 0);
});

test('a switch recorded without its pointer degrades to a fresh start on the old model', async () => {
  // Markers written before `fromSessionId` existed: the era is known, the
  // conversation is not. Starting fresh on the right model beats continuing on
  // the wrong one.
  const older = SWITCHED.map((e) =>
    e.kind === 'provider-switch'
      ? ev(e.seq, 'provider-switch', { from: 'claude-opus-5-5', to: 'gpt-5.6-terra', summarized: true })
      : e,
  );
  const h = harness(
    { model: 'gpt-5.6-terra', claudeSessionId: undefined, codexThreadId: 'th-codex' },
    older,
  );

  const verdict = await h.sessions.rewindSession('s', 2);
  assert.equal(verdict.ok, true, verdict.ok === false ? verdict.reason : '');
  assert.equal(h.forks.length, 0, 'nothing to fork');
  const m = h.sessions.get('s')!;
  assert.equal(m.model, 'claude-opus-5-5');
  assert.equal(m.claudeSessionId, undefined);
  assert.equal(m.codexThreadId, undefined);
});
