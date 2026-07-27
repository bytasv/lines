import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionStatus, TranscriptEvent } from '@lines/shared';
import { KEEP_PLANNING_MESSAGE } from '@lines/shared';
import { planReplyDecision } from './sessions.ts';

let seq = 0;
const ev = (kind: TranscriptEvent['kind'], data: unknown): TranscriptEvent =>
  ({ seq: ++seq, ts: 0, kind, data }) as TranscriptEvent;

const request = (requestId: string, toolName = 'ExitPlanMode') =>
  ev('permission', { requestId, toolName, input: {} });
const resolution = (requestId: string, res = 'deny') =>
  ev('permission', { requestId, toolName: '', input: {}, resolution: res });

const decide = (over: Partial<Parameters<typeof planReplyDecision>[0]> = {}) =>
  planReplyDecision({
    status: 'waiting-permission' as SessionStatus,
    pendingPermissionTool: 'ExitPlanMode',
    text: 'add a rollback step',
    hasAttachments: false,
    livePendingIds: ['r1'],
    events: [request('r1')],
    ...over,
  });

test('falls through when the session is not waiting on a permission', () => {
  assert.equal(decide({ status: 'idle' as SessionStatus }), null);
});

test('falls through when the pending card is some other tool', () => {
  assert.equal(decide({ pendingPermissionTool: 'Bash' }), null);
});

test('falls through on whitespace-only text', () => {
  assert.equal(decide({ text: '   \n ' }), null);
});

test('falls through when no ExitPlanMode request can be found', () => {
  assert.equal(decide({ livePendingIds: [], events: [] }), null);
});

test('picks the live pending ExitPlanMode request over a stale transcript one', () => {
  const got = decide({
    livePendingIds: ['live'],
    events: [request('stale'), request('live'), request('other', 'Bash')],
  });
  assert.equal(got?.requestId, 'live');
});

test('ignores a live pending id belonging to another tool', () => {
  const got = decide({
    livePendingIds: ['bash1'],
    events: [request('plan1'), request('bash1', 'Bash')],
  });
  assert.equal(got?.requestId, 'plan1');
});

test('falls back to the newest unresolved ExitPlanMode when the live map is empty', () => {
  const got = decide({
    livePendingIds: [],
    events: [request('old'), request('newer'), request('answered'), resolution('answered')],
  });
  assert.equal(got?.requestId, 'newer');
});

test('no attachments: the reason wraps the keep-planning prefix around the typed text', () => {
  const got = decide({ text: '  add a rollback step  ' });
  assert.equal(
    got?.denyMessage,
    `${KEEP_PLANNING_MESSAGE}\n\nThe user's message:\nadd a rollback step`,
  );
  assert.equal(got?.alsoQueue, false);
});

test('attachments: the reason never repeats the text the queued turn will carry', () => {
  const got = decide({ text: 'look at this', hasAttachments: true });
  assert.ok(got?.denyMessage.startsWith(KEEP_PLANNING_MESSAGE));
  assert.ok(!got!.denyMessage.includes('look at this'));
  assert.equal(got?.alsoQueue, true);
});
