import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CODEX_NOTIFICATION,
  codexToolUseId,
  isCodexNotification,
  normalizeCodexNotification,
} from '@lines/shared';

/** Deterministic ids, so a mapping assertion is about the mapping. */
function deps(extra: Record<string, unknown> = {}) {
  let n = 0;
  return { newId: () => `id${++n}`, model: 'gpt-5.6-terra', ...extra };
}

/** The `content` blocks of a normalized assistant message. */
function blocks(msg: Record<string, unknown>): Record<string, unknown>[] {
  return (msg as unknown as { message: { content: Record<string, unknown>[] } }).message.content;
}

/** The `event` payload of a normalized stream message. */
function streamOf(msg: Record<string, unknown>): Record<string, unknown> {
  return (msg as unknown as { event: Record<string, unknown> }).event;
}

const run = (method: string, params: Record<string, unknown> = {}, extra = {}) =>
  normalizeCodexNotification(method, params, deps(extra));

test('thread/started captures the resume pointer and emits nothing', () => {
  const out = run('thread/started', { thread: { id: 'th_1' } });
  assert.equal(out.threadId, 'th_1');
  assert.deepEqual(out.messages, []);
});

test('an unknown notification is inert, not an error', () => {
  // The protocol is experimental and grows; a method we do not read must not
  // break a turn.
  assert.deepEqual(run('thread/goal/updated', { threadId: 't' }), { messages: [] });
});

// --- streaming ------------------------------------------------------------
// The envelope is what matters: `isDroppable` on the bridge and the supersede
// rule in the client store both key off kind:'sdk' + type:'stream_event'. A
// delta in any other shape would be undroppable and pile up client-side.

test('every streamed message wears the droppable stream_event envelope', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['turn/started', {}],
    ['item/started', { item: { type: 'agentMessage', id: 'i1', text: '' } }],
    ['item/agentMessage/delta', { delta: 'hi' }],
    ['item/reasoning/textDelta', { delta: 'mm' }],
  ];
  for (const [method, params] of cases) {
    const [msg] = run(method, params).messages;
    assert.equal(msg?.type, 'stream_event', method);
  }
});

test('an agent message delta streams as text, reasoning as thinking', () => {
  const text = streamOf(run('item/agentMessage/delta', { delta: 'hello' }).messages[0]);
  assert.equal(text.type, 'content_block_delta');
  assert.deepEqual(text.delta, { type: 'text_delta', text: 'hello' });

  const thinking = streamOf(run('item/reasoning/textDelta', { delta: 'hmm' }).messages[0]);
  assert.deepEqual(thinking.delta, { type: 'thinking_delta', thinking: 'hmm' });
  // The summary variant is the same phase to the user.
  const summary = streamOf(run('item/reasoning/summaryTextDelta', { delta: 'hmm' }).messages[0]);
  assert.deepEqual(summary.delta, { type: 'thinking_delta', thinking: 'hmm' });
});

test('an empty delta produces nothing rather than an empty block', () => {
  assert.deepEqual(run('item/agentMessage/delta', { delta: '' }).messages, []);
});

test('a starting item opens the block its live row needs', () => {
  const started = (item: Record<string, unknown>) =>
    streamOf(run('item/started', { item }).messages[0]).content_block;
  assert.deepEqual(started({ type: 'agentMessage', id: 'i', text: '' }), { type: 'text' });
  assert.deepEqual(started({ type: 'reasoning', id: 'i', summary: [], content: [] }), {
    type: 'thinking',
  });
  assert.deepEqual(started({ type: 'commandExecution', id: 'i', command: 'ls' }), {
    type: 'tool_use',
    name: 'Bash',
  });
});

// --- durable items --------------------------------------------------------

test('an agent message becomes an assistant text message with a uuid', () => {
  const out = run('item/completed', {
    item: { type: 'agentMessage', id: 'i1', text: 'hello' },
  });
  const msg = out.messages[0];
  assert.equal(msg.type, 'assistant');
  // The rewind anchor scan keys off this; a message without one is invisible to it.
  assert.equal(typeof msg.uuid, 'string');
  assert.deepEqual(blocks(msg), [{ type: 'text', text: 'hello' }]);
  assert.equal(msg._engine, 'codex');
});

test("codex's echo of the user's own prompt is dropped", () => {
  // Lines already wrote its own 'user' event when the prompt was sent; keeping
  // this one would double every prompt in the transcript.
  assert.deepEqual(
    run('item/completed', { item: { type: 'userMessage', id: 'i', content: [] } }).messages,
    [],
  );
});

test('reasoning prefers the readable summary over the raw trace', () => {
  const out = run('item/completed', {
    item: { type: 'reasoning', id: 'i', summary: ['short'], content: ['long raw trace'] },
  });
  assert.deepEqual(blocks(out.messages[0]), [
    { type: 'thinking', thinking: 'short', signature: '' },
  ]);
  // With no summary the raw content is better than nothing.
  const raw = run('item/completed', {
    item: { type: 'reasoning', id: 'i', summary: [], content: ['long raw trace'] },
  });
  assert.match(String(blocks(raw.messages[0])[0].thinking), /long raw trace/);
});

test('a command execution maps to a paired tool_use and tool_result', () => {
  const out = run('item/completed', {
    item: {
      type: 'commandExecution',
      id: 'i7',
      command: 'ls -la',
      aggregatedOutput: 'a\nb',
      exitCode: 0,
      status: 'completed',
    },
  });
  const [call, result] = out.messages;
  const use = blocks(call)[0];
  assert.equal(use.name, 'Bash');
  assert.deepEqual(use.input, { command: 'ls -la' });
  // Derived from the item id, not minted: this is what pairs the two messages in
  // the renderer with no shared state.
  assert.equal(use.id, codexToolUseId('i7'));
  const block = (result as unknown as { message: { content: Record<string, unknown>[] } }).message
    .content[0];
  assert.equal(block.tool_use_id, codexToolUseId('i7'));
  assert.equal(block.is_error, undefined);
});

test('a non-zero exit code makes the tool result an error', () => {
  const out = run('item/completed', {
    item: {
      type: 'commandExecution',
      id: 'i8',
      command: 'false',
      aggregatedOutput: '',
      exitCode: 1,
      status: 'completed',
    },
  });
  const block = (out.messages[1] as unknown as { message: { content: Record<string, unknown>[] } })
    .message.content[0];
  assert.equal(block.is_error, true);
});

test('a file change renders plain, never as an edit tool', () => {
  // Codex reports no before/after, so pairing it into a diff card would promise a
  // diff that does not exist — and the file-write tool names are what the
  // server's change attribution scans for.
  const out = run('item/completed', {
    item: {
      type: 'fileChange',
      id: 'i9',
      changes: [{ path: '/repo/a.ts', kind: 'update' }],
      status: 'completed',
    },
  });
  const use = blocks(out.messages[0])[0];
  assert.equal(use.name, 'ApplyPatch');
  assert.ok(!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(String(use.name)));
});

test('items with a real Claude-shaped home use it rather than being dropped', () => {
  // Each of these has an existing home the renderer already knows how to draw, so
  // dropping them lost information for no reason.
  const toolName = (item: Record<string, unknown>) =>
    blocks(run('item/completed', { item }).messages[0])[0].name;

  // Codex sub-agents land in the Task card Claude subagents already use.
  assert.equal(
    toolName({ type: 'subAgentActivity', id: 'i', kind: 'started', agentThreadId: 't', agentPath: 'explore' }),
    'Task',
  );
  assert.equal(toolName({ type: 'functionCallOutput', id: 'i', name: 'lookup', output: 'ok' }), 'lookup');
  assert.equal(toolName({ type: 'imageView', id: 'i', path: '/tmp/a.png' }), 'ViewImage');
});

test('the compaction notification maps to the same boundary as the item', () => {
  // Two routes, one record: measured, 0.154.0 sends the item — but whichever
  // arrives, the bridge reads one boundary.
  const [msg] = run('thread/compacted', { threadId: 't' }).messages;
  assert.equal(msg.subtype, 'compact_boundary');
});

test('a compaction marker becomes the boundary the bridge already reads', () => {
  // system/compact_boundary is what self-corrects the occupancy reading and
  // records that a compaction happened — a tool card would do neither.
  const [msg] = run('item/completed', { item: { type: 'contextCompaction', id: 'i' } }).messages;
  assert.equal(msg.type, 'system');
  assert.equal(msg.subtype, 'compact_boundary');
});

test('an item with no Claude-shaped home is dropped, not invented', () => {
  // A made-up tool row would read as work the agent did not do.
  assert.deepEqual(
    run('item/completed', { item: { type: 'enteredReviewMode', id: 'i', review: 'x' } }).messages,
    [],
  );
});

// --- settling -------------------------------------------------------------

test('usage is carried forward and folded into the settling result', () => {
  const usage = {
    totalTokens: 137,
    inputTokens: 100,
    cachedInputTokens: 20,
    cacheWriteInputTokens: 5,
    outputTokens: 30,
    reasoningOutputTokens: 7,
  };
  // Usage arrives on its own notification ahead of the turn settling.
  const seen = run('thread/tokenUsage/updated', { tokenUsage: { last: usage } });
  assert.deepEqual(seen.usage, usage);
  assert.deepEqual(seen.messages, []);

  const out = normalizeCodexNotification(
    'turn/completed',
    { turn: { id: 't', status: 'completed', durationMs: 1234 } },
    deps({ lastUsage: usage }),
  );
  const result = out.messages[0] as unknown as Record<string, unknown> & {
    usage: Record<string, number>;
  };
  assert.equal(result.type, 'result');
  assert.equal(result.is_error, false);
  assert.equal(result.usage.input_tokens, 100);
  // Exactly what the provider called output — reasoning is carried beside it, not
  // folded in, so the canonical field means what its name says.
  assert.equal(result.usage.output_tokens, 30);
  assert.equal(result.usage.reasoning_output_tokens, 7);
  assert.equal(result.usage.cache_read_input_tokens, 20);
  assert.equal(result.usage.cache_creation_input_tokens, 5);
  assert.equal(result.duration_ms, 1234);
  // Codex reports tokens, never a price.
  assert.equal(result.total_cost_usd, undefined);
});

test('a failed turn carries its message verbatim, not a result', () => {
  // Failure is a status on turn/completed, not a notification of its own.
  const out = run('turn/completed', {
    turn: { id: 't', status: 'failed', error: { message: 'insufficient_quota' } },
  });
  assert.equal(out.failure, 'insufficient_quota');
  assert.deepEqual(out.messages, []);
});

test('an interrupted turn settles, and is flagged as stopped rather than failed', () => {
  const out = run('turn/completed', { turn: { id: 't', status: 'interrupted' } });
  assert.equal(out.interrupted, true);
  assert.equal(out.messages[0].type, 'result');
  assert.equal(out.failure, undefined);
});

test('only the codex envelope routes to the normalizer', () => {
  assert.equal(
    isCodexNotification({ type: CODEX_NOTIFICATION, method: 'item/started', params: {} }),
    true,
  );
  // SDK message types must never be mistaken for codex notifications — that is
  // what lets one handleWorkerEvent accept both engines.
  for (const type of ['assistant', 'user', 'result', 'system', 'stream_event']) {
    assert.equal(isCodexNotification({ type }), false, type);
  }
  // A half-built envelope is not one: params is read without a guard downstream.
  assert.equal(isCodexNotification({ type: CODEX_NOTIFICATION, method: 'x' }), false);
  assert.equal(isCodexNotification(null), false);
});
