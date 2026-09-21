import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  bootDial,
  probeExpired,
  wakeAction,
  wakeDebounced,
  WAKE_DEBOUNCE_MS,
  WAKE_PROBE_TIMEOUT_MS,
  type LinkProbeState,
} from '../../web/src/lib/wake.ts';

/**
 * Coming back to a tab that was left open.
 *
 * The rules here exist because a backgrounded tab breaks the two assumptions the
 * transport otherwise relies on: that timers run on time, and that a dead socket
 * announces itself. Lives in the server workspace because that is where the test
 * runner is — the same arrangement as machineMerge.test.ts.
 */

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const link = (over: Partial<LinkProbeState> = {}): LinkProbeState => ({
  readyState: OPEN,
  awaitingProbeSince: null,
  lastPongAt: 0,
  ...over,
});

describe('wakeAction', () => {
  test('a socket the OS closed while the tab slept is re-dialled at once', () => {
    // Without this the only thing that notices is the heartbeat: a 10s pong
    // timeout plus a 1.5s retry delay, all of it after the user is already
    // looking at the page.
    assert.equal(wakeAction(link({ readyState: CLOSED }), 1_000), 'redial');
  });

  test('a closing socket is re-dialled too — it is not coming back', () => {
    assert.equal(wakeAction(link({ readyState: CLOSING }), 1_000), 'redial');
  });

  test('a socket still connecting is left alone', () => {
    assert.equal(wakeAction(link({ readyState: CONNECTING }), 1_000), 'none');
  });

  test('an open socket is probed, never closed on suspicion', () => {
    // The common case is a healthy link. Closing it to find out would cost every
    // tab switch a reconnect and a fresh hello.
    assert.equal(wakeAction(link({ readyState: OPEN }), 1_000), 'probe');
  });

  test('a pong that landed after the probe went out means the link is healthy', () => {
    const s = link({ awaitingProbeSince: 1_000, lastPongAt: 1_050 });
    assert.equal(wakeAction(s, 1_000 + WAKE_PROBE_TIMEOUT_MS), 'none');
    assert.equal(probeExpired(s, 1_000 + WAKE_PROBE_TIMEOUT_MS), false);
  });

  test('a probe still in flight is not re-probed', () => {
    const s = link({ awaitingProbeSince: 1_000, lastPongAt: 500 });
    assert.equal(wakeAction(s, 1_500), 'none');
  });

  test("the heartbeat's stall forgiveness cannot rescue an unanswered probe", () => {
    // ws.ts re-baselines `lastPongAt = now` whenever a heartbeat tick runs late,
    // and the first tick after a resume is always late. A check against
    // PONG_TIMEOUT_MS would therefore call a dead socket healthy. Comparing
    // against the probe's own stamp is what makes the resumed-tab case work.
    const stamp = 10_000;
    const s = link({ awaitingProbeSince: stamp, lastPongAt: stamp - 1 });
    assert.equal(probeExpired(s, stamp + WAKE_PROBE_TIMEOUT_MS), true);
    assert.equal(wakeAction(s, stamp + WAKE_PROBE_TIMEOUT_MS), 'redial');
  });

  test('a probe is given its full timeout before the link is declared dead', () => {
    const s = link({ awaitingProbeSince: 10_000, lastPongAt: 0 });
    assert.equal(probeExpired(s, 10_000 + WAKE_PROBE_TIMEOUT_MS - 1), false);
  });

  test('no probe in flight is never expired', () => {
    assert.equal(probeExpired(link(), 1_000_000), false);
  });
});

describe('wakeDebounced', () => {
  test('the second of a visibilitychange/pageshow pair is swallowed', () => {
    // Both fire on a bfcache restore, milliseconds apart.
    assert.equal(wakeDebounced(1_000, 1_002), true);
  });

  test('a wake outside the window is acted on', () => {
    assert.equal(wakeDebounced(1_000, 1_000 + WAKE_DEBOUNCE_MS), false);
  });

  test('the very first wake is never debounced', () => {
    assert.equal(wakeDebounced(0, Date.now()), false);
  });
});

describe('bootDial', () => {
  test('nothing remembered means nothing to dial — the user picks', () => {
    assert.deepEqual(bootDial(null, null, null), { dial: null, drop: null });
  });

  test('the remembered machine is dialled before the list lands', () => {
    assert.deepEqual(bootDial('m1', null, null), { dial: 'm1', drop: null });
  });

  test('a machine already dialled is not dialled again', () => {
    assert.deepEqual(bootDial('m1', null, 'm1'), { dial: null, drop: null });
  });

  test('the guess is kept when the list confirms it', () => {
    assert.deepEqual(bootDial('m1', [{ id: 'm1' }, { id: 'm2' }], 'm1'), { dial: null, drop: null });
  });

  test('a guess the list does not contain is dropped', () => {
    // Otherwise the link sits on a revoked machine retrying every 5s, and each
    // 1008 retry re-reads /v1/devices — a refresh loop.
    assert.deepEqual(bootDial('m1', [{ id: 'm2' }], 'm1'), { dial: null, drop: 'm1' });
  });

  test('an empty list drops the guess rather than leaving it live', () => {
    assert.deepEqual(bootDial('m1', [], 'm1'), { dial: null, drop: 'm1' });
  });

  test('with the list in hand and nothing dialled, the gate is left to choose', () => {
    assert.deepEqual(bootDial('m1', [{ id: 'm1' }], null), { dial: null, drop: null });
  });
});
