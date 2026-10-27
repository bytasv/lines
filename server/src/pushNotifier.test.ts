import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { alertBody, isAlertTransition, isSessionMuted } from '@lines/shared';
import type { GuestPushRegistration, PushRegistration, SessionMeta, WorkflowState, WorkflowStepStatus } from '@lines/shared';
import {
  GUEST_PUSH_CAP,
  PushNotifier,
  guestMayPush,
  isAllowedPushEndpoint,
  parseRegistration,
  pushPayload,
  type GuestPushReach,
} from './pushNotifier.ts';

/**
 * Web Push of session alerts from the bridge.
 *
 * The transition rule is shared with the page's in-app chime, so what is pinned
 * here is also what the desktop tab chimes on. The network is never touched: the
 * sender is injected.
 */

const b64 = (n: number, fill = 1) => Buffer.alloc(n, fill).toString('base64url');

const reg = (endpoint = 'https://fcm.googleapis.com/fcm/send/abc'): PushRegistration => ({
  subscription: { endpoint, keys: { p256dh: b64(65), auth: b64(16) } },
  vapid: { publicKey: b64(65, 4), privateKey: b64(32, 7) },
});

const session = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id: 's1', name: 'Fix the build', status: 'idle', ...over }) as SessionMeta;

const wf = (stepIndex: number, stepStatuses: WorkflowStepStatus[], started = true): WorkflowState => ({
  workflowId: 'w1',
  stepIndex,
  stepStatuses,
  started,
});

/** An in-memory stand-in for the Store methods the notifier uses. */
function memStore(initial: PushRegistration[] = [], initialGuests: GuestPushRegistration[] = []) {
  let rows = initial;
  let guestRows = initialGuests;
  let saves = 0;
  let guestSaves = 0;
  return {
    loadPushSubscriptions: () => rows,
    savePushSubscriptions: (next: PushRegistration[]) => {
      rows = [...next];
      saves++;
    },
    loadGuestPushSubscriptions: () => guestRows,
    saveGuestPushSubscriptions: (next: GuestPushRegistration[]) => {
      guestRows = [...next];
      guestSaves++;
    },
    get rows() {
      return rows;
    },
    get saves() {
      return saves;
    },
    get guestRows() {
      return guestRows;
    },
    get guestSaves() {
      return guestSaves;
    },
  };
}

const machineGuest = (over: Partial<GuestPushReach> = {}): GuestPushReach => ({
  userId: 'guest-a',
  grantIds: ['g-machine'],
  scope: 'machine',
  ...over,
});

const sessionGuest = (sessionIds: string[], over: Partial<GuestPushReach> = {}): GuestPushReach => ({
  userId: 'guest-b',
  grantIds: ['g-session'],
  scope: 'session',
  sessionIds,
  ...over,
});

/** Drive one alerting transition for a session. */
function transition(n: PushNotifier, id: string): void {
  n.onSessionUpsert(session({ id, status: 'running' }));
  n.onSessionUpsert(session({ id, status: 'done' }));
}

/** A sender that records calls and answers with whatever `answer` returns. */
function recorder(answer: () => Promise<unknown> = () => Promise.resolve()) {
  const calls: { endpoint: string; payload: unknown }[] = [];
  const send = (r: PushRegistration, payload: string) => {
    calls.push({ endpoint: r.subscription.endpoint, payload: JSON.parse(payload) });
    return answer();
  };
  return { calls, send };
}

/** Let the fire-and-forget send and its catch settle. */
const settle = () => new Promise((r) => setImmediate(r));

describe('isAlertTransition', () => {
  test('pushes on idle -> done and running -> waiting-permission', () => {
    assert.equal(isAlertTransition('idle', session({ status: 'done' })), true);
    assert.equal(isAlertTransition('running', session({ status: 'waiting-permission' })), true);
    assert.equal(isAlertTransition('running', session({ status: 'waiting-approval' })), true);
  });

  test('a first sighting is not a transition', () => {
    assert.equal(isAlertTransition(undefined, session({ status: 'done' })), false);
  });

  test('no push when the status repeats', () => {
    assert.equal(isAlertTransition('done', session({ status: 'done' })), false);
  });

  test('no push into a non-alert status', () => {
    assert.equal(isAlertTransition('idle', session({ status: 'running' })), false);
    assert.equal(isAlertTransition('running', session({ status: 'error' })), false);
  });

  test('no push for an archived session', () => {
    assert.equal(isAlertTransition('running', session({ status: 'done', archived: true })), false);
  });

  test('no push while background tasks are still running', () => {
    const next = session({ status: 'done', backgroundTasks: [{}] as SessionMeta['backgroundTasks'] });
    assert.equal(isAlertTransition('running', next), false);
  });

  test('no push when an intermediate workflow step settles', () => {
    const next = session({ status: 'done', workflow: wf(0, ['running', 'pending', 'pending']) });
    assert.equal(isAlertTransition('running', next), false);
  });

  test('pushes when the last workflow step settles', () => {
    const next = session({ status: 'done', workflow: wf(2, ['done', 'done', 'running']) });
    assert.equal(isAlertTransition('running', next), true);
  });

  test('pushes when a workflow step parks for approval', () => {
    const next = session({ status: 'waiting-approval', workflow: wf(0, ['waiting-approval', 'pending', 'pending']) });
    assert.equal(isAlertTransition('done', next), true);
  });

  test('no push when a step the user already iterated on parks again', () => {
    const next = session({
      status: 'waiting-approval',
      workflow: { ...wf(0, ['waiting-approval', 'pending']), iteratedStep: 0 },
    });
    assert.equal(isAlertTransition('running', next), false);
  });

  test("a stale iteratedStep from an earlier step does not silence the next step's first park", () => {
    const next = session({
      status: 'waiting-approval',
      workflow: { ...wf(1, ['done', 'waiting-approval']), iteratedStep: 0 },
    });
    assert.equal(isAlertTransition('running', next), true);
  });

  test('a failed step park stays out of the alert statuses, iterated or not', () => {
    const failed = session({
      status: 'error',
      workflow: { ...wf(0, ['waiting-approval', 'pending']), stepFailure: 'turn' },
    });
    assert.equal(isAlertTransition('running', failed), false);
  });

  test('a permission prompt inside an iterated step still pushes', () => {
    const next = session({
      status: 'waiting-permission',
      workflow: { ...wf(0, ['running', 'pending']), iteratedStep: 0 },
    });
    assert.equal(isAlertTransition('running', next), true);
  });

  test('pushes on a follow-up chat after the workflow finished', () => {
    const next = session({ status: 'done', workflow: wf(2, ['done', 'done', 'done']) });
    assert.equal(isAlertTransition('running', next), true);
  });

  test('pushes in a workflow that has not started', () => {
    const next = session({ status: 'done', workflow: wf(0, ['running', 'pending', 'pending'], false) });
    assert.equal(isAlertTransition('running', next), true);
  });
});

describe('alertBody', () => {
  test('a workflow park reads as the step it finished', () => {
    const park = session({ status: 'waiting-approval', workflow: wf(1, ['done', 'waiting-approval', 'pending']) });
    assert.equal(alertBody(park), 'Step 2 of 3 finished');
  });

  test('a park with no workflow falls back to a plain label', () => {
    assert.equal(alertBody(session({ status: 'waiting-approval' })), 'Step finished');
  });
});

describe('isAllowedPushEndpoint', () => {
  test('accepts the known push services', () => {
    assert.equal(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/x'), true);
    assert.equal(isAllowedPushEndpoint('https://web.push.apple.com/QK1'), true);
    assert.equal(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'), true);
    assert.equal(isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x'), true);
  });

  test('rejects http, IP addresses, ports and arbitrary hosts', () => {
    assert.equal(isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/x'), false);
    assert.equal(isAllowedPushEndpoint('https://127.0.0.1/x'), false);
    assert.equal(isAllowedPushEndpoint('https://169.254.169.254/latest/meta-data'), false);
    assert.equal(isAllowedPushEndpoint('https://[::1]/x'), false);
    assert.equal(isAllowedPushEndpoint('https://fcm.googleapis.com:8443/x'), false);
    assert.equal(isAllowedPushEndpoint('https://example.com/x'), false);
    // Suffix, not substring: the allowed name as a prefix of an attacker's domain.
    assert.equal(isAllowedPushEndpoint('https://push.apple.com.evil.test/x'), false);
    assert.equal(isAllowedPushEndpoint('https://evilpush.apple.com/x'), false);
    assert.equal(isAllowedPushEndpoint('https://user:pw@fcm.googleapis.com/x'), false);
    assert.equal(isAllowedPushEndpoint('not a url'), false);
  });
});

describe('parseRegistration', () => {
  test('keeps a well-formed registration', () => {
    assert.deepEqual(parseRegistration(reg()), reg());
  });

  test('rejects malformed keys', () => {
    const bad = reg();
    bad.vapid.privateKey = b64(31);
    assert.equal(parseRegistration(bad), null);
    const badAuth = reg();
    badAuth.subscription.keys.auth = 'not base64url!';
    assert.equal(parseRegistration(badAuth), null);
  });
});

describe('PushNotifier', () => {
  test('register upserts by endpoint', () => {
    const store = memStore();
    const n = new PushNotifier(store, recorder().send);
    assert.equal(n.register(reg()), true);
    const updated = reg();
    updated.vapid.publicKey = b64(65, 9);
    assert.equal(n.register(updated), true);
    assert.equal(n.registrations.length, 1);
    assert.equal(n.registrations[0].vapid.publicKey, updated.vapid.publicKey);
    assert.equal(store.rows.length, 1);
  });

  test('an identical re-register (every hello) does not rewrite the file', () => {
    const store = memStore();
    const n = new PushNotifier(store, recorder().send);
    n.register(reg());
    n.register(reg());
    assert.equal(store.saves, 1);
  });

  test('register refuses an endpoint off the allowlist, and stores nothing', () => {
    const store = memStore();
    const n = new PushNotifier(store, recorder().send);
    assert.equal(n.register(reg('https://10.0.0.5/push')), false);
    assert.equal(n.registrations.length, 0);
    assert.equal(store.saves, 0);
  });

  test('unregister removes by endpoint', () => {
    const store = memStore();
    const n = new PushNotifier(store, recorder().send);
    n.register(reg('https://fcm.googleapis.com/a'));
    n.register(reg('https://fcm.googleapis.com/b'));
    n.unregister('https://fcm.googleapis.com/a');
    assert.deepEqual(
      n.registrations.map((r) => r.subscription.endpoint),
      ['https://fcm.googleapis.com/b'],
    );
    assert.equal(store.rows.length, 1);
  });

  test('drops invalid rows found on disk', () => {
    const n = new PushNotifier(memStore([reg(), reg('http://evil.test/')]), recorder().send);
    assert.equal(n.registrations.length, 1);
  });

  test('pushes a transition, with a minimal payload', async () => {
    const rec = recorder();
    const n = new PushNotifier(memStore([reg()]), rec.send);
    n.onSessionUpsert(session({ status: 'running' }));
    n.onSessionUpsert(session({ status: 'done' }));
    await settle();
    assert.equal(rec.calls.length, 1);
    assert.deepEqual(rec.calls[0].payload, { sessionId: 's1', title: 'Fix the build', body: 'Task complete' });
  });

  test('no push for a session in a muted group, and the status is still tracked', async () => {
    const rec = recorder();
    const n = new PushNotifier(memStore([reg()]), rec.send);
    const groups = [{ id: 'g1', name: 'For future', muted: true }];
    n.isMuted = (s) => isSessionMuted(s, groups);
    n.onSessionUpsert(session({ status: 'running', groupId: 'g1' }));
    n.onSessionUpsert(session({ status: 'done', groupId: 'g1' }));
    await settle();
    assert.equal(rec.calls.length, 0);
    // Unmuted: the next transition pushes as usual.
    groups[0].muted = false;
    n.onSessionUpsert(session({ status: 'running', groupId: 'g1' }));
    n.onSessionUpsert(session({ status: 'done', groupId: 'g1' }));
    await settle();
    assert.equal(rec.calls.length, 1);
  });

  test('the first sighting of a session does not push', async () => {
    const rec = recorder();
    const n = new PushNotifier(memStore([reg()]), rec.send);
    n.onSessionUpsert(session({ status: 'done' }));
    await settle();
    assert.equal(rec.calls.length, 0);
  });

  test('a repeated status does not push twice', async () => {
    const rec = recorder();
    const n = new PushNotifier(memStore([reg()]), rec.send);
    n.onSessionUpsert(session({ status: 'running' }));
    n.onSessionUpsert(session({ status: 'waiting-permission', pendingPermissionTool: 'Bash' }));
    n.onSessionUpsert(session({ status: 'waiting-permission', pendingPermissionTool: 'Bash' }));
    await settle();
    assert.equal(rec.calls.length, 1);
    assert.equal((rec.calls[0].payload as { body: string }).body, 'Needs permission');
  });

  test('a mid-workflow settle does not push, the park that follows does', async () => {
    const rec = recorder();
    const n = new PushNotifier(memStore([reg()]), rec.send);
    n.onSessionUpsert(session({ status: 'running', workflow: wf(0, ['running', 'pending']) }));
    n.onSessionUpsert(session({ status: 'done', workflow: wf(0, ['running', 'pending']) }));
    await settle();
    assert.equal(rec.calls.length, 0);
    n.onSessionUpsert(session({ status: 'waiting-approval', workflow: wf(0, ['waiting-approval', 'pending']) }));
    await settle();
    assert.equal(rec.calls.length, 1);
    assert.equal((rec.calls[0].payload as { body: string }).body, 'Step 1 of 2 finished');
  });

  test('a 410 from the push service deletes the subscription', async () => {
    const store = memStore([reg()]);
    const rec = recorder(() => Promise.reject(Object.assign(new Error('Gone'), { statusCode: 410 })));
    const n = new PushNotifier(store, rec.send);
    n.onSessionUpsert(session({ status: 'running' }));
    n.onSessionUpsert(session({ status: 'done' }));
    await settle();
    assert.equal(rec.calls.length, 1);
    assert.equal(n.registrations.length, 0);
    assert.equal(store.rows.length, 0);
  });

  test('any other failure keeps the subscription', async () => {
    const rec = recorder(() => Promise.reject(Object.assign(new Error('busy'), { statusCode: 503 })));
    const n = new PushNotifier(memStore([reg()]), rec.send);
    n.onSessionUpsert(session({ status: 'running' }));
    n.onSessionUpsert(session({ status: 'done' }));
    await settle();
    assert.equal(n.registrations.length, 1);
  });
});

describe('PushNotifier guests', () => {
  test('a machine guest is pushed for any session', async () => {
    const rec = recorder();
    const n = new PushNotifier(memStore(), rec.send);
    assert.equal(n.registerGuest(reg('https://fcm.googleapis.com/guest'), machineGuest()), true);
    transition(n, 's1');
    transition(n, 's2');
    await settle();
    assert.deepEqual(
      rec.calls.map((c) => (c.payload as { sessionId: string }).sessionId),
      ['s1', 's2'],
    );
  });

  test('a session guest is pushed only for its own sessions', async () => {
    const rec = recorder();
    const n = new PushNotifier(memStore(), rec.send);
    n.registerGuest(reg('https://fcm.googleapis.com/guest'), sessionGuest(['s1']));
    transition(n, 's1');
    transition(n, 'sibling');
    await settle();
    assert.deepEqual(
      rec.calls.map((c) => (c.payload as { sessionId: string }).sessionId),
      ['s1'],
    );
  });

  test('guestMayPush mirrors the per-session reach', () => {
    const machine = { ...reg(), guest: machineGuest() };
    const scoped = { ...reg(), guest: sessionGuest(['s1']) };
    assert.equal(guestMayPush(machine, 'anything'), true);
    assert.equal(guestMayPush(scoped, 's1'), true);
    assert.equal(guestMayPush(scoped, 's2'), false);
  });

  test('owner pushes still go to every session alongside guest rows', async () => {
    const rec = recorder();
    const n = new PushNotifier(memStore([reg('https://fcm.googleapis.com/owner')]), rec.send);
    n.registerGuest(reg('https://fcm.googleapis.com/guest'), sessionGuest(['s1']));
    transition(n, 's2');
    await settle();
    assert.deepEqual(rec.calls.map((c) => c.endpoint), ['https://fcm.googleapis.com/owner']);
  });

  test('dropGuestGrants removes matching rows and leaves the rest', () => {
    const store = memStore([reg('https://fcm.googleapis.com/owner')]);
    const n = new PushNotifier(store, recorder().send);
    n.registerGuest(reg('https://fcm.googleapis.com/a'), machineGuest({ grantIds: ['g1', 'g2'] }));
    n.registerGuest(reg('https://fcm.googleapis.com/b'), sessionGuest(['s1'], { grantIds: ['g3'] }));
    n.dropGuestGrants(new Set(['g2']));
    assert.deepEqual(
      n.guestRegistrations.map((r) => r.subscription.endpoint),
      ['https://fcm.googleapis.com/b'],
    );
    assert.equal(store.guestRows.length, 1);
    assert.equal(n.registrations.length, 1);
    assert.equal(store.saves, 0);
  });

  test("a guest registering the owner's endpoint leaves the owner row alone", () => {
    const owner = reg('https://fcm.googleapis.com/shared');
    const store = memStore([owner]);
    const n = new PushNotifier(store, recorder().send);
    const theirs = reg('https://fcm.googleapis.com/shared');
    theirs.vapid.publicKey = b64(65, 9);
    assert.equal(n.registerGuest(theirs, machineGuest()), true);
    assert.deepEqual(n.registrations, [owner]);
    assert.equal(store.saves, 0);
    assert.equal(n.guestRegistrations.length, 1);
  });

  test('a device that is both an owner and a guest row is pushed once', async () => {
    const rec = recorder();
    const n = new PushNotifier(memStore([reg('https://fcm.googleapis.com/shared')]), rec.send);
    n.registerGuest(reg('https://fcm.googleapis.com/shared'), machineGuest());
    transition(n, 's1');
    await settle();
    assert.equal(rec.calls.length, 1);
  });

  test('an identical guest re-register does not rewrite the file', () => {
    const store = memStore();
    const n = new PushNotifier(store, recorder().send);
    n.registerGuest(reg(), machineGuest());
    n.registerGuest(reg(), machineGuest());
    assert.equal(store.guestSaves, 1);
  });

  test('the per-guest cap evicts that guest’s oldest row only', () => {
    const n = new PushNotifier(memStore(), recorder().send);
    n.registerGuest(reg('https://fcm.googleapis.com/other'), sessionGuest(['s1']));
    for (let i = 0; i <= GUEST_PUSH_CAP; i++) {
      n.registerGuest(reg(`https://fcm.googleapis.com/a${i}`), machineGuest());
    }
    const endpoints = n.guestRegistrations.map((r) => r.subscription.endpoint);
    assert.equal(endpoints.filter((e) => e.includes('/a')).length, GUEST_PUSH_CAP);
    assert.equal(endpoints.includes('https://fcm.googleapis.com/a0'), false);
    assert.equal(endpoints.includes(`https://fcm.googleapis.com/a${GUEST_PUSH_CAP}`), true);
    assert.equal(endpoints.includes('https://fcm.googleapis.com/other'), true);
  });

  test("unregisterGuest cannot remove another guest's or the owner's row", () => {
    const n = new PushNotifier(memStore([reg('https://fcm.googleapis.com/owner')]), recorder().send);
    n.registerGuest(reg('https://fcm.googleapis.com/b'), sessionGuest(['s1']));
    n.unregisterGuest('https://fcm.googleapis.com/owner', 'guest-a');
    n.unregisterGuest('https://fcm.googleapis.com/b', 'guest-a');
    assert.equal(n.registrations.length, 1);
    assert.equal(n.guestRegistrations.length, 1);
    n.unregisterGuest('https://fcm.googleapis.com/b', 'guest-b');
    assert.equal(n.guestRegistrations.length, 0);
  });

  test('a 410 on a guest row removes it from the guest list only', async () => {
    const store = memStore([reg('https://fcm.googleapis.com/owner')]);
    const rec = recorder();
    const send = (r: PushRegistration, payload: string) =>
      r.subscription.endpoint.endsWith('/guest')
        ? Promise.reject(Object.assign(new Error('Gone'), { statusCode: 410 }))
        : rec.send(r, payload);
    const n = new PushNotifier(store, send);
    n.registerGuest(reg('https://fcm.googleapis.com/guest'), machineGuest());
    transition(n, 's1');
    await settle();
    assert.equal(n.guestRegistrations.length, 0);
    assert.equal(n.registrations.length, 1);
    assert.equal(store.saves, 0);
  });

  test('the allowlist still refuses a bad endpoint from a guest', () => {
    const store = memStore();
    const n = new PushNotifier(store, recorder().send);
    assert.equal(n.registerGuest(reg('https://10.0.0.5/push'), machineGuest()), false);
    assert.equal(n.guestRegistrations.length, 0);
    assert.equal(store.guestSaves, 0);
  });

  test('a muted session is silent for guests too', async () => {
    const rec = recorder();
    const n = new PushNotifier(memStore(), rec.send);
    n.isMuted = () => true;
    n.registerGuest(reg(), machineGuest());
    transition(n, 's1');
    await settle();
    assert.equal(rec.calls.length, 0);
  });

  test('drops guest rows on disk without a usable reach', () => {
    const n = new PushNotifier(
      memStore([], [
        { ...reg('https://fcm.googleapis.com/ok'), guest: machineGuest() },
        { ...reg('https://fcm.googleapis.com/nogrant'), guest: machineGuest({ grantIds: [] }) },
        { ...reg('https://fcm.googleapis.com/nolist'), guest: { userId: 'x', grantIds: ['g'], scope: 'session' } },
      ]),
      recorder().send,
    );
    assert.deepEqual(
      n.guestRegistrations.map((r) => r.subscription.endpoint),
      ['https://fcm.googleapis.com/ok'],
    );
  });
});

describe('pushPayload', () => {
  test('names the permission kind like the sidebar does', () => {
    assert.equal(
      pushPayload(session({ status: 'waiting-permission', pendingPermissionTool: 'ExitPlanMode' }))?.body,
      'Plan ready',
    );
    assert.equal(pushPayload(session({ status: 'running' })), null);
  });
});
