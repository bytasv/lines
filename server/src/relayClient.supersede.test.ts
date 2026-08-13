import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { WebSocketServer } from 'ws';

/**
 * The supersede circuit breaker.
 *
 * A relay that accepts a dial and immediately hangs up with 1012 used to keep the
 * bridge at the retry floor forever: `open` reset the backoff, and a supersede close
 * always follows a successful open. Two bridges sharing one device identity then
 * kicked each other twice a second, indefinitely.
 *
 * Timings are compressed through the same env vars a deployment would leave alone
 * (see .env.example). Set before the import, because the constants are read at
 * module load — and real timers, not mock ones, because the thing under test is the
 * *gap between real socket dials* (relay/src/agentHeartbeat.test.ts makes the same
 * call for the same reason).
 */
process.env.LINES_RELAY_STABLE_MS = '400';
process.env.LINES_SUPERSEDE_LIMIT = '4';
process.env.LINES_SUPERSEDE_CAP_MS = '1500';

const { RelayClient } = await import('./relayClient.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clients: InstanceType<typeof RelayClient>[] = [];
const servers: WebSocketServer[] = [];

after(async () => {
  for (const c of clients) c.dispose();
  for (const s of servers) s.close();
  await sleep(50);
});

async function until<T>(fn: () => T | null | undefined, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/**
 * A relay that supersedes every bridge that dials in. `holdFor(n)` says how long
 * the n-th socket lives before the 1012 — 0 for the takeover war, longer than
 * LINES_RELAY_STABLE_MS to look like a working link.
 */
async function supersedingRelay(holdFor: (index: number) => number) {
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  const dials: number[] = [];
  wss.on('connection', (ws) => {
    ws.on('error', () => {});
    const hold = holdFor(dials.length);
    dials.push(Date.now());
    if (hold <= 0) ws.close(1012, 'superseded');
    else setTimeout(() => ws.close(1012, 'superseded'), hold).unref();
  });
  await new Promise<void>((resolve) => wss.on('listening', resolve));
  return { port: (wss.address() as { port: number }).port, dials };
}

function bridgeAgainst(port: number) {
  const client = new RelayClient(`ws://127.0.0.1:${port}`, 'dev', 'secret', {
    onChannel: () => {},
    onToken: () => {},
  });
  clients.push(client);
  return client;
}

const gapsOf = (dials: number[]) => dials.slice(1).map((at, i) => at - dials[i]);

test('re-dials back off through a supersede war and settle at the escalated cap', async () => {
  const relay = await supersedingRelay(() => 0);
  bridgeAgainst(relay.port);

  await until(() => relay.dials.length >= 6 || null, 'six dials');
  const gaps = gapsOf(relay.dials);

  // The exponent accumulates at all: gap 3 is drawn from [2000,4000] where gap 1
  // came from [500,1000]. Under the old reset-on-open behaviour every gap sat in
  // that first band forever.
  assert.ok(gaps[2] > gaps[0], `expected growth, got ${gaps.join(', ')}`);
  // Then the cap swaps from RECONNECT_CAP_MS to the escalated one, which is
  // compressed *below* it here — so an unescalated gap 4 would be [2000,4000] and
  // this one cannot be.
  assert.ok(gaps[3] < 2_000, `gap 4 should be capped at 1500ms, got ${gaps[3]}`);
  assert.ok(gaps[4] < 2_000, `gap 5 should stay capped, got ${gaps[4]}`);
});

test('a socket that survives RELAY_STABLE_MS resets the backoff', async () => {
  // Third dial is held open past 400ms: a link that actually worked, so the run of
  // supersedes is not evidence of a rival bridge and the exponent must go back to 0.
  const relay = await supersedingRelay((i) => (i === 2 ? 600 : 0));
  bridgeAgainst(relay.port);

  await until(() => relay.dials.length >= 4 || null, 'four dials');
  const gaps = gapsOf(relay.dials);

  // Gap 3 includes the 600ms the socket was held, so the reset floor is ~1100-1600.
  // Without the reset the third backoff would be 4000ms, i.e. 2600ms at the very least.
  assert.ok(gaps[2] < 2_000, `expected a reset backoff, got ${gaps.join(', ')}`);
});
