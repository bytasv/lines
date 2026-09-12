import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  codexToolUseId,
  isCodexEvent,
  normalizeCodexEvent,
  type CodexEvent,
} from '@lines/shared';

/** Deterministic ids, so a mapping assertion is about the mapping. */
function deps() {
  let n = 0;
  return { newId: () => `id${++n}`, model: 'gpt-5.6-terra' };
}

/** The `content` blocks of a normalized assistant message. */
function blocks(msg: Record<string, unknown>): Record<string, unknown>[] {
  return (msg as unknown as { message: { content: Record<string, unknown>[] } }).message.content;
}

test('thread.started captures the resume pointer and emits nothing', () => {
  const out = normalizeCodexEvent({ type: 'thread.started', thread_id: 'th_1' }, deps());
  assert.equal(out.threadId, 'th_1');
  assert.deepEqual(out.messages, []);
});

test('an agent message becomes an assistant text message with a uuid', () => {
  const out = normalizeCodexEvent(
    { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hello' } },
    deps(),
  );
  assert.equal(out.messages.length, 1);
  const msg = out.messages[0];
  assert.equal(msg.type, 'assistant');
  // The rewind anchor scan keys off this; a message without one is invisible to it.
  assert.equal(typeof msg.uuid, 'string');
  assert.deepEqual(blocks(msg), [{ type: 'text', text: 'hello' }]);
  // Provenance: nothing from the JSONL is lost by the Claude-shaped envelope.
  assert.equal(msg._engine, 'codex');
  assert.equal((msg._codex as { id: string }).id, 'i1');
});

test('reasoning becomes a thinking block, not visible text', () => {
  const out = normalizeCodexEvent(
    { type: 'item.completed', item: { id: 'i1', type: 'reasoning', text: 'thinking…' } },
    deps(),
  );
  assert.deepEqual(blocks(out.messages[0])[0].type, 'thinking');
});

test('a command execution maps to a paired tool_use and tool_result', () => {
  const out = normalizeCodexEvent(
    {
      type: 'item.completed',
      item: {
        id: 'i7',
        type: 'command_execution',
        command: 'ls -la',
        aggregated_output: 'a\nb',
        exit_code: 0,
        status: 'completed',
      },
    },
    deps(),
  );
  assert.equal(out.messages.length, 2);
  const [call, result] = out.messages;
  const use = blocks(call)[0];
  assert.equal(use.type, 'tool_use');
  assert.equal(use.name, 'Bash');
  assert.deepEqual(use.input, { command: 'ls -la' });
  // Derived from the codex item id, not minted: this is what pairs the two
  // messages in the renderer with no shared state.
  assert.equal(use.id, codexToolUseId('i7'));
  const block = (result as unknown as { message: { content: Record<string, unknown>[] } }).message
    .content[0];
  assert.equal(block.type, 'tool_result');
  assert.equal(block.tool_use_id, codexToolUseId('i7'));
  assert.match(String(block.content), /a\nb/);
  assert.equal(block.is_error, undefined);
});

test('a non-zero exit code makes the tool result an error', () => {
  const out = normalizeCodexEvent(
    {
      type: 'item.completed',
      item: {
        id: 'i8',
        type: 'command_execution',
        command: 'false',
        aggregated_output: '',
        exit_code: 1,
        status: 'completed',
      },
    },
    deps(),
  );
  const block = (out.messages[1] as unknown as { message: { content: Record<string, unknown>[] } })
    .message.content[0];
  assert.equal(block.is_error, true);
});

test('a file change renders plain, never as an edit tool', () => {
  // Codex reports no before/after, so pairing it into a diff card would promise a
  // diff that does not exist — and the file-write tool names are what the server's
  // change attribution scans for.
  const out = normalizeCodexEvent(
    {
      type: 'item.completed',
      item: {
        id: 'i9',
        type: 'file_change',
        changes: [{ path: '/repo/a.ts', kind: 'update' }],
        status: 'completed',
      },
    },
    deps(),
  );
  const use = blocks(out.messages[0])[0];
  assert.equal(use.name, 'ApplyPatch');
  assert.ok(!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(String(use.name)));
});

test('an mcp tool call keeps its server and tool in the name', () => {
  const out = normalizeCodexEvent(
    {
      type: 'item.completed',
      item: {
        id: 'i10',
        type: 'mcp_tool_call',
        server: 'linear',
        tool: 'list_issues',
        arguments: { team: 'x' },
        result: 'ok',
        status: 'completed',
      },
    },
    deps(),
  );
  assert.equal(blocks(out.messages[0])[0].name, 'mcp__linear__list_issues');
});

test('turn.completed settles as a success result whose tokens include reasoning', () => {
  const out = normalizeCodexEvent(
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 100,
        cached_input_tokens: 20,
        cache_write_input_tokens: 5,
        output_tokens: 30,
        reasoning_output_tokens: 7,
      },
    },
    deps(),
  );
  const result = out.messages[0] as unknown as Record<string, unknown> & {
    usage: Record<string, number>;
  };
  assert.equal(result.type, 'result');
  assert.equal(result.subtype, 'success');
  assert.equal(result.is_error, false);
  assert.equal(result.usage.input_tokens, 100);
  // Reasoning tokens are billed output; folding them in is what keeps the
  // session's spend from under-reporting.
  assert.equal(result.usage.output_tokens, 37);
  assert.equal(result.usage.cache_read_input_tokens, 20);
  assert.equal(result.usage.cache_creation_input_tokens, 5);
  // Codex reports neither, and both are optional downstream.
  assert.equal(result.total_cost_usd, undefined);
  assert.equal(result.duration_ms, undefined);
});

test('turn.failed and a bare error both carry their message verbatim', () => {
  assert.equal(
    normalizeCodexEvent({ type: 'turn.failed', error: { message: 'boom' } }, deps()).failure,
    'boom',
  );
  assert.equal(
    normalizeCodexEvent({ type: 'error', message: 'stream died' }, deps()).failure,
    'stream died',
  );
});

test('partials produce nothing at all', () => {
  // Streaming them would need them to be droppable, and only `kind:'sdk'`
  // stream_event is — undroppable partials would pile up client-side.
  const item = { id: 'i1', type: 'agent_message', text: 'partial' } as const;
  for (const type of ['item.started', 'item.updated', 'turn.started'] as const) {
    const event = (type === 'turn.started' ? { type } : { type, item }) as CodexEvent;
    assert.deepEqual(normalizeCodexEvent(event, deps()), { messages: [] });
  }
});

test('only codex event types route to the normalizer', () => {
  assert.equal(isCodexEvent({ type: 'item.completed' }), true);
  assert.equal(isCodexEvent({ type: 'turn.completed' }), true);
  // SDK message types must never be mistaken for codex events.
  for (const type of ['assistant', 'user', 'result', 'system', 'stream_event']) {
    assert.equal(isCodexEvent({ type }), false, type);
  }
  assert.equal(isCodexEvent(null), false);
});
