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
  assert.deepEqual([...((await sync.liveGrantIds('dev-a')) ?? [])].sort(), ['g-invite', 'g-member']);
  assert.match(urls[0] ?? '', /\/v1\/shares$/);
});

test('an older storage server that records no grant ids is "cannot say", not "no shares"', async (t) => {
  const { sync } = client(t, () => json({ granted: [], invites: [], received: [] }));
  assert.equal(await sync.liveGrantIds('dev-a'), null);
});

test('an error is "cannot say" too', async (t) => {
  const { sync } = client(t, () => json({ error: 'boom' }, 503));
  assert.equal(await sync.liveGrantIds('dev-a'), null);
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
  assert.equal(await sync.liveGrantIds('dev-a'), null);
  assert.equal(asked, false);
});
