import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerMessage, TranscriptEvent } from '@lines/shared';
import { linkSendAction } from './userContext.ts';

/**
 * `ws.send()` buffers without limit. On loopback the socket drains instantly, so
 * a slow client never cost anything; over a relay a suspended laptop would make
 * bridge memory climb without bound. These pin the policy that bounds it.
 */

const MB = 1024 * 1024;

const sdkEvent = (data: unknown): ServerMessage => ({
  type: 'event',
  sessionId: 's1',
  event: { seq: 1, ts: 0, kind: 'sdk', data } as unknown as TranscriptEvent,
});

const streamDelta = sdkEvent({ type: 'stream_event' });
const result = sdkEvent({ type: 'result' });
const upsert = {
  type: 'sessionUpsert',
  session: { id: 's1' },
} as unknown as ServerMessage;

test('everything sends on a drained link', () => {
  for (const msg of [streamDelta, result, upsert]) {
    assert.equal(linkSendAction(msg, 0), 'send');
  }
});

test('a backed-up link keeps critical messages but sheds stream deltas', () => {
  const buffered = 8 * MB;
  assert.equal(linkSendAction(streamDelta, buffered), 'skip');
  // Losing a delta costs a partially-typed token; losing these costs state.
  assert.equal(linkSendAction(result, buffered), 'send');
  assert.equal(linkSendAction(upsert, buffered), 'send');
});

test('a wedged link is closed even for critical messages', () => {
  const buffered = 64 * MB;
  assert.equal(linkSendAction(upsert, buffered), 'close');
  assert.equal(linkSendAction(result, buffered), 'close');
  assert.equal(linkSendAction(streamDelta, buffered), 'close');
});

test('only sdk stream_event counts as droppable', () => {
  const buffered = 8 * MB;
  // A non-sdk event that happens to carry a stream_event-ish payload, and an sdk
  // event of another type, are both state the client cannot refetch mid-stream.
  const permission = {
    type: 'event',
    sessionId: 's1',
    event: { seq: 1, ts: 0, kind: 'permission', data: { type: 'stream_event' } },
  } as unknown as ServerMessage;
  assert.equal(linkSendAction(permission, buffered), 'send');
  assert.equal(linkSendAction(sdkEvent({ type: 'assistant' }), buffered), 'send');
});

test('an sdk event with no data is not droppable', () => {
  assert.equal(linkSendAction(sdkEvent(null), 8 * MB), 'send');
  assert.equal(linkSendAction(sdkEvent(undefined), 8 * MB), 'send');
});

test('thresholds are far above anything loopback produces', () => {
  // A few hundred KB queued is an ordinary burst, not backpressure — if this
  // ever starts returning 'skip', local dev would silently lose stream deltas.
  assert.equal(linkSendAction(streamDelta, 512 * 1024), 'send');
});
