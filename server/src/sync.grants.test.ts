import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { StorageSyncClient } from './sync.ts';

/**
 * The bridge drops a guest grant once storage stops listing the share behind it
 * (guestGrants.ts reconcileGuestGrants). That is only safe against a real
 * answer: anything short of one — an error, an older storage server that does
 * not record grant ids — must read as "cannot say", never as "no shares", or a
 * storage outage would end every guest's access.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(t: TestContext, respond: () => Response | Promise<Response>): { sync: StorageSyncClient; urls: string[] } {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return respond();
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const sync = new StorageSyncClient('http://storage.test', () => 'clerk-token', () => {}, {}, () => {}, { probeMs: 60_000 });
  return { sync, urls };
}

test('the ids of live shares and invites on this device, and only this device', async (t) => {
  const { sync, urls } = client(t, () =>
    json({
      grantTracking: true,
      granted: [
        { kind: 'machine', deviceId: 'dev-a', grantId: 'g-member' },
        { kind: 'session', deviceId: 'dev-b', grantId: 'g-elsewhere' },
        { kind: 'session', deviceId: 'dev-a', grantId: null },
      ],
      invites: [{ deviceId: 'dev-a', grantId: 'g-invite' }],
      received: [],
    }),
  );
  assert.deepEqual([...((await sync.liveGrants('dev-a'))?.ids ?? [])].sort(), ['g-invite', 'g-member']);
  assert.match(urls[0] ?? '', /\/v1\/shares$/);
});

test('members are this device\'s granted rows only: machine and session, never invites or other devices', async (t) => {
  const { sync } = client(t, () =>
    json({
      grantTracking: true,
      granted: [
        { kind: 'machine', deviceId: 'dev-a', grantId: 'g-1', userId: 'u-machine' },
        { kind: 'session', deviceId: 'dev-a', grantId: 'g-2', userId: 'u-session', sessionId: 's-1' },
        { kind: 'machine', deviceId: 'dev-b', grantId: 'g-3', userId: 'u-elsewhere' },
        { kind: 'machine', deviceId: 'dev-a', grantId: 'g-4' },
      ],
      invites: [{ deviceId: 'dev-a', grantId: 'g-invite', sessionId: null, inviteeEmail: 'x@example.com' }],
      received: [],
    }),
  );
  assert.deepEqual((await sync.liveGrants('dev-a'))?.members, [
    { guestUserId: 'u-machine', scope: 'machine' },
    { guestUserId: 'u-session', scope: 'session', sessionId: 's-1' },
  ]);
});

test('an older storage server that records no grant ids is "cannot say", not "no shares"', async (t) => {
  const { sync } = client(t, () => json({ granted: [], invites: [], received: [] }));
  assert.equal(await sync.liveGrants('dev-a'), null);
});

test('an error is "cannot say" too', async (t) => {
  const { sync } = client(t, () => json({ error: 'boom' }, 503));
  assert.equal(await sync.liveGrants('dev-a'), null);
});

test('with no token there is nobody to ask', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let asked = false;
  globalThis.fetch = (async () => {
    asked = true;
    return json({});
  }) as typeof fetch;
  const sync = new StorageSyncClient('http://storage.test', () => null, () => {}, {}, () => {}, { probeMs: 60_000 });
  assert.equal(await sync.liveGrants('dev-a'), null);
  assert.equal(asked, false);
});
