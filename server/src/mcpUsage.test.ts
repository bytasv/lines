import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TranscriptEvent } from '@lines/shared';
import { mcpCallCount, summarizeMcpUsage } from '../../web/src/lib/mcpUsage.ts';

/**
 * Session MCP usage (web/src/lib/mcpUsage.ts), tested from the server's runner
 * because that is the only test runner this repo has.
 */

let seq = 0;
function ev(kind: TranscriptEvent['kind'], data: unknown): TranscriptEvent {
  return { seq: ++seq, ts: seq, kind, data };
}

function call(id: string, name: string, parent?: string): TranscriptEvent {
  return ev('sdk', {
    type: 'assistant',
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { content: [{ type: 'tool_use', id, name, input: {} }] },
  });
}

function result(id: string, isError = false): TranscriptEvent {
  return ev('sdk', {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x', is_error: isError }] },
  });
}

function ask(requestId: string, toolName: string): TranscriptEvent {
  return ev('permission', { requestId, toolName, input: {} });
}

function answer(
  requestId: string,
  toolName: string,
  resolution: 'allow' | 'deny' | 'expired',
  resolvedBy?: string,
): TranscriptEvent {
  return ev('permission', { requestId, toolName, input: {}, resolution, ...(resolvedBy ? { resolvedBy } : {}) });
}

describe('summarizeMcpUsage', () => {
  test('groups calls per server and tool, most-called first, counting errors and subagent calls', () => {
    const usage = summarizeMcpUsage([
      call('t1', 'mcp__vercel__list_projects'),
      result('t1'),
      call('t2', 'mcp__linear__create_issue'),
      result('t2'),
      call('t3', 'mcp__linear__create_issue', 'agent1'),
      result('t3', true),
      call('t4', 'mcp__linear__get_issue'),
      call('t5', 'Bash'),
      // A re-delivered message does not count twice.
      call('t2', 'mcp__linear__create_issue'),
    ]);
    assert.deepEqual(
      usage.map((u) => [u.server, u.calls, u.errors]),
      [
        ['linear', 3, 1],
        ['vercel', 1, 0],
      ],
    );
    assert.deepEqual(
      usage[0].tools.map((t) => [t.tool, t.calls, t.errors]),
      [
        ['create_issue', 2, 1],
        ['get_issue', 1, 0],
      ],
    );
    assert.equal(mcpCallCount(usage), 4);
  });

  test('attributes access per tool name: user allow and deny, allowlist, unprompted', () => {
    const name = 'mcp__linear__create_issue';
    const usage = summarizeMcpUsage([
      ask('r1', name),
      answer('r1', name, 'allow', 'user'),
      call('t1', name),
      ask('r2', name),
      answer('r2', name, 'deny'),
      call('t2', name),
      ask('r3', name),
      answer('r3', name, 'allow', 'auto'),
      call('t3', name),
      call('t4', name),
      // A stop sweeping a pending card and an expired card are not decisions.
      ask('r5', name),
      answer('r5', name, 'deny', 'stop'),
      ask('r6', name),
      answer('r6', name, 'expired'),
      // Non-MCP permissions are ignored.
      ask('r7', 'Bash'),
      answer('r7', 'Bash', 'allow', 'user'),
    ]);
    assert.equal(usage.length, 1);
    assert.deepEqual(usage[0].tools[0].access, { user: 1, auto: 1, denied: 1, unprompted: 1 });
  });

  test('empty for a session with no MCP calls', () => {
    assert.deepEqual(summarizeMcpUsage([call('t1', 'Read'), result('t1')]), []);
  });
});
