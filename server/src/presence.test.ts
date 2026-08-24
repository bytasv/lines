import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ShareProfile } from '@lines/shared';
import { PresenceTracker } from './presence.ts';

/**
 * Presence bookkeeping. The interesting cases are all about *leaving*: a viewer
 * who is not cleaned up is an avatar of someone who is not there, which is worse
 * than showing nobody.
 */

const profile = (userId: string): ShareProfile => ({
  userId,
  email: `${userId}@example.com`,
  name: userId,
  imageUrl: null,
});

const enter = (
  t: PresenceTracker,
  sessionId: string,
  connId: string,
  userId = connId,
  focused = false,
) => t.signal({ sessionId, connId, userId, profile: profile(userId), viewing: true, focused });

describe('PresenceTracker', () => {
  test('a viewer appears in the session they are watching', () => {
    const t = new PresenceTracker();
    assert.deepEqual(enter(t, 's1', 'c1'), ['s1'], 'the session needs a broadcast');
    assert.deepEqual(
      t.viewers('s1').map((v) => v.userId),
      ['c1'],
    );
    assert.deepEqual(t.viewers('s2'), [], 'other sessions are untouched');
  });

  test('two tabs of one person are two viewers, and closing one keeps the other', () => {
    // Keyed by connection, not user: otherwise closing one tab makes you vanish
    // from the session you are still watching in the other.
    const t = new PresenceTracker();
    enter(t, 's1', 'tabA', 'sam');
    enter(t, 's1', 'tabB', 'sam');
    assert.equal(t.viewers('s1').length, 2);

    t.drop('tabA');
    assert.deepEqual(
      t.viewers('s1').map((v) => v.connId),
      ['tabB'],
    );
  });

  test('moving to another session leaves no ghost behind', () => {
    // Clicking through sessions must not accumulate a trail of viewers who are
    // no longer looking at any of them.
    const t = new PresenceTracker();
    enter(t, 's1', 'c1');
    const changed = enter(t, 's2', 'c1');
    assert.deepEqual(t.viewers('s1'), [], 's1 must be emptied');
    assert.equal(t.viewers('s2').length, 1);
    assert.deepEqual(changed.sort(), ['s1', 's2'], 'both sessions need a broadcast');
  });

  test('viewing:false is a departure', () => {
    const t = new PresenceTracker();
    enter(t, 's1', 'c1');
    const changed = t.signal({
      sessionId: 's1',
      connId: 'c1',
      userId: 'c1',
      profile: null,
      viewing: false,
      focused: false,
    });
    assert.deepEqual(changed, ['s1']);
    assert.deepEqual(t.viewers('s1'), []);
  });

  test('an identical heartbeat is not a change', () => {
    // Otherwise every keepalive fans a broadcast out to every watcher of the
    // session, which is exactly the cost presence is supposed to avoid.
    const t = new PresenceTracker();
    enter(t, 's1', 'c1');
    assert.deepEqual(enter(t, 's1', 'c1'), [], 'no broadcast for an unchanged signal');
  });

  test('a focus change is a change', () => {
    const t = new PresenceTracker();
    enter(t, 's1', 'c1', 'c1', false);
    assert.deepEqual(enter(t, 's1', 'c1', 'c1', true), ['s1']);
    assert.equal(t.viewers('s1')[0].focused, true);
  });

  test('dropping an unknown connection is silent', () => {
    // The close handler fires for every socket, including ones that never sent a
    // presence signal at all.
    assert.deepEqual(new PresenceTracker().drop('never-seen'), []);
  });

  test('lastSeenAt advances without forcing a broadcast', () => {
    const t = new PresenceTracker();
    t.signal({ sessionId: 's1', connId: 'c1', userId: 'u', profile: null, viewing: true, focused: false }, 1000);
    const changed = t.signal(
      { sessionId: 's1', connId: 'c1', userId: 'u', profile: null, viewing: true, focused: false },
      5000,
    );
    assert.deepEqual(changed, []);
    assert.equal(t.viewers('s1')[0].lastSeenAt, 5000, 'the timestamp still moves');
  });
});
