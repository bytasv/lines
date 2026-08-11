import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerMessage, SessionMeta, SessionStatus } from '@lines/shared';
import { reportRelayStatus, UpdateManager } from './updates.ts';

/**
 * A restart always kills in-flight turns — bridge and worker go down together
 * under one atomic app update. So the only interesting behaviour here is the
 * refusal, and the fact that none of it exists outside the desktop shell.
 */

const session = (status: SessionStatus): SessionMeta => ({ id: 's', status }) as SessionMeta;

function manager(sessions: SessionMeta[]) {
  const sent: ServerMessage[] = [];
  const mgr = new UpdateManager(
    () => sessions,
    (msg) => sent.push(msg),
  );
  return { mgr, sent };
}

/** Pretend the tray app spawned us. */
function withSend<T>(fn: (calls: unknown[]) => T): T {
  const original = process.send;
  const calls: unknown[] = [];
  (process as { send?: unknown }).send = (msg: unknown) => {
    calls.push(msg);
    return true;
  };
  try {
    return fn(calls);
  } finally {
    (process as { send?: unknown }).send = original;
  }
}

test('an idle app restarts on request', () => {
  withSend((calls) => {
    const { mgr } = manager([session('idle'), session('done')]);
    assert.equal(mgr.busy, false);
    assert.equal(mgr.requestRestart(), true);
    assert.deepEqual(calls, [{ type: 'updateRestartRequest' }]);
  });
});

test('a running turn blocks the restart', () => {
  withSend((calls) => {
    const { mgr } = manager([session('idle'), session('running')]);
    assert.equal(mgr.busy, true);
    assert.equal(mgr.requestRestart(), false);
    assert.deepEqual(calls, [], 'the shell must not even be asked');
    assert.equal(mgr.current().restartBlocked, true);
  });
});

test('a session waiting on the user also blocks it', () => {
  withSend(() => {
    // waiting-permission and waiting-approval are live turns parked on a human;
    // restarting would throw away work the user is about to unblock.
    for (const status of ['running', 'waiting-permission', 'waiting-approval'] as const) {
      const { mgr } = manager([session(status)]);
      assert.equal(mgr.requestRestart(), false, `${status} must block a restart`);
    }
    for (const status of ['idle', 'done', 'error'] as const) {
      const { mgr } = manager([session(status)]);
      assert.equal(mgr.requestRestart(), true, `${status} must not block a restart`);
    }
  });
});

test('without the desktop shell it is completely inert', () => {
  const original = process.send;
  (process as { send?: unknown }).send = undefined;
  try {
    const { mgr, sent } = manager([session('idle')]);
    assert.equal(mgr.supervised, false);
    // Tilt and `npm run dev` must never see an update path at all.
    assert.equal(mgr.requestRestart(), false);
    assert.deepEqual(sent, []);
  } finally {
    (process as { send?: unknown }).send = original;
  }
});

test('status from the shell is broadcast with the live busy flag folded in', () => {
  const { mgr, sent } = manager([session('running')]);
  process.emit('message', { type: 'updateStatus', status: { state: 'ready', version: '1.2.3' } } as never, undefined);

  const msg = sent.at(-1) as { type: string; status: { state: string; version: string; restartBlocked: boolean } };
  assert.equal(msg.type, 'updateStatus');
  assert.equal(msg.status.state, 'ready');
  assert.equal(msg.status.version, '1.2.3');
  // The shell cannot know this; the bridge supplies it.
  assert.equal(msg.status.restartBlocked, true);
  assert.equal(mgr.current().restartBlocked, true);
});

test('relay transitions reach the shell over the same channel', () => {
  withSend((calls) => {
    reportRelayStatus({ connected: true });
    // 1008 is the relay refusing this device — the shell turns that into
    // "Not paired", so the code has to survive the hop.
    reportRelayStatus({ connected: false, code: 1008, reason: 'unauthorized' });
    assert.deepEqual(calls, [
      { type: 'relayStatus', status: { connected: true } },
      { type: 'relayStatus', status: { connected: false, code: 1008, reason: 'unauthorized' } },
    ]);
  });
});

test('relay reporting is inert without the desktop shell', () => {
  const original = process.send;
  (process as { send?: unknown }).send = undefined;
  try {
    // Under Tilt and `npm run dev` there is no parent listening; this must not throw.
    reportRelayStatus({ connected: true });
  } finally {
    (process as { send?: unknown }).send = original;
  }
});
