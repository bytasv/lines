import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { WorkerStatus } from '@lines/shared';
import { WebSocketServer, type WebSocket } from 'ws';

// Isolate this run's runtime-discovery directory from any real worker on the
// machine (RUNTIME_DIR is derived from LINES_INSTANCE at module load, so this
// must be set before workerClient/workerProtocol are ever imported).
process.env.LINES_INSTANCE = `test-${randomUUID()}`;

const { WorkerClient } = await import('./workerClient.ts');
const { RUNTIME_DIR, PROTOCOL_VERSION, WORKER_TOKEN_HEADER, publishRuntimeInfo, clearRuntimeInfo } =
  await import('./workerProtocol.ts');

// The instance is unique per run, so without this every run leaves a directory
// behind under ~/.lines-app/run/ forever.
after(() => fs.rmSync(RUNTIME_DIR, { recursive: true, force: true }));

/**
 * Real timers throughout, with the client's own intervals compressed instead.
 * Mocking the clock is not an option here: the client owns a live WebSocket and
 * `ws` schedules real timers of its own, so a faked clock underneath it
 * corrupts node's timer list the moment the socket closes.
 */
const RETRY_MS = 20;
const LOST_MS = 200;

async function until(cond: () => boolean, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake worker: binds an ephemeral port, publishes it, and says hello to
 *  anyone presenting the right token — enough for WorkerClient to connect.
 *  `version` overrides the hello's protocol version, to play a stale worker;
 *  `appVersion` plays a worker built at a given package version. */
function startFakeWorker({
  version,
  appVersion,
}: { version?: number; appVersion?: string } = {}): Promise<{ close: () => void }> {
  return new Promise((resolve) => {
    const token = randomUUID();
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const clients = new Set<WebSocket>();
    wss.on('listening', () => {
      const { port } = wss.address() as { port: number };
      publishRuntimeInfo('worker', {
        port,
        pid: process.pid,
        startedAt: Date.now(),
        protocolVersion: PROTOCOL_VERSION,
        token,
      });
      resolve({
        close: () => {
          clearRuntimeInfo('worker');
          // wss.close() only stops new connections; without terminating the live
          // ones the client never sees a 'close', so it never starts its outage
          // clock and onWorkerLost can't fire.
          for (const c of clients) c.terminate();
          wss.close();
        },
      });
    });
    wss.on('connection', (ws, req) => {
      if (req.headers[WORKER_TOKEN_HEADER] !== token) {
        ws.close(1008);
        return;
      }
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.send(
        JSON.stringify({
          type: 'hello',
          version: version ?? PROTOCOL_VERSION,
          // Omitted entirely when unset, which is also how a worker too old to
          // report one behaves.
          ...(appVersion ? { appVersion } : {}),
          live: [],
        }),
      );
    });
  });
}

function startClient(onWorkerLost: () => void, onStatusChange: (s: WorkerStatus) => void = () => {}) {
  return new WorkerClient(
    {
      onHello: () => {},
      onEvent: () => {},
      onEnded: () => {},
      onRpc: () => {},
      onRpcCancel: () => {},
      onWorkerLost,
      onStatusChange,
    },
    { retryMs: RETRY_MS, lostMs: LOST_MS },
  );
}

test('onWorkerLost fires once after the socket is down for the whole deadline', async (t) => {
  const worker = await startFakeWorker();
  let lostCount = 0;
  const client = startClient(() => lostCount++);
  t.after(() => client.dispose());

  await until(() => client.everConnected, 'fake worker hello');

  worker.close();
  // Well inside the deadline: the outage clock has started but not expired.
  await sleep(LOST_MS / 2);
  assert.equal(lostCount, 0, 'must not fire before the deadline');

  await until(() => lostCount === 1, 'onWorkerLost');

  // Stays fired once for the rest of the same outage, despite the retry loop
  // re-checking every RETRY_MS.
  await sleep(LOST_MS);
  assert.equal(lostCount, 1, 'fires once per outage, not once per retry tick');
});

test('onWorkerLost does not fire when the worker reconnects inside the deadline', async (t) => {
  const worker = await startFakeWorker();
  let lostCount = 0;
  const client = startClient(() => lostCount++);
  t.after(() => client.dispose());

  await until(() => client.everConnected, 'fake worker hello');

  worker.close();

  // Same shape as a tsx-watch restart: gone, then back on a new port well
  // inside the deadline. Republishing is what the retry loop picks up.
  const restarted = await startFakeWorker();
  t.after(() => restarted.close());

  await sleep(LOST_MS * 2);
  assert.equal(lostCount, 0, 'reconnected long before the deadline');
});

test('onStatusChange publishes one disconnected status when the worker is lost', async (t) => {
  const worker = await startFakeWorker();
  const statuses: WorkerStatus[] = [];
  const client = startClient(
    () => {},
    (s) => statuses.push(s),
  );
  t.after(() => client.dispose());

  await until(() => client.everConnected, 'fake worker hello');
  // A healthy start is the assumed state, so nothing is published for it.
  assert.equal(statuses.length, 0);

  const downAt = Date.now();
  worker.close();
  await until(() => statuses.length === 1, 'disconnected status');

  const [status] = statuses;
  assert.equal(status.connected, false);
  assert.equal(status.mismatch, undefined, 'a plain outage carries no version pair');
  assert.ok(status.since !== undefined && status.since >= downAt, '`since` stamps the outage start');
  assert.equal(client.status.connected, false, 'the getter agrees with what was published');

  // The retry loop keeps ticking; the status must not be republished per tick.
  await sleep(LOST_MS);
  assert.equal(statuses.length, 1, 'publishes on transition, not on every retry tick');
});

test('onStatusChange publishes nothing when the worker reconnects inside the deadline', async (t) => {
  const worker = await startFakeWorker();
  const statuses: WorkerStatus[] = [];
  const client = startClient(
    () => {},
    (s) => statuses.push(s),
  );
  t.after(() => client.dispose());

  await until(() => client.everConnected, 'fake worker hello');

  worker.close();
  const restarted = await startFakeWorker();
  t.after(() => restarted.close());

  await sleep(LOST_MS * 2);
  assert.equal(statuses.length, 0, 'a tsx-watch blip is not a status transition');
});

test('onStatusChange publishes connected exactly once after a lost worker returns', async (t) => {
  const worker = await startFakeWorker();
  const statuses: WorkerStatus[] = [];
  const client = startClient(
    () => {},
    (s) => statuses.push(s),
  );
  t.after(() => client.dispose());

  await until(() => client.everConnected, 'fake worker hello');

  worker.close();
  await until(() => statuses.length === 1, 'disconnected status');

  const restarted = await startFakeWorker();
  t.after(() => restarted.close());

  await until(() => statuses.length === 2, 'reconnected status');
  assert.equal(statuses[1].connected, true);
  assert.equal(statuses[1].since, undefined, 'a healthy link has no outage start');

  await sleep(LOST_MS);
  assert.equal(statuses.length, 2, 'the re-arm publishes once');
});

// The cold-start hang this whole change exists for: a worker on a protocol the
// bridge can't speak never sets `everConnected`, so the outage clock never
// starts and `onWorkerLost` can never fire. Without `mismatch` the UI shows a
// permanent silent spinner.
test('a never-compatible worker publishes a mismatch without ever connecting', async (t) => {
  const stale = await startFakeWorker({ version: PROTOCOL_VERSION + 1 });
  t.after(() => stale.close());
  const statuses: WorkerStatus[] = [];
  let lostCount = 0;
  const client = startClient(
    () => lostCount++,
    (s) => statuses.push(s),
  );
  t.after(() => client.dispose());

  await until(() => statuses.length === 1, 'mismatch status');

  const [status] = statuses;
  assert.equal(status.connected, false);
  assert.deepEqual(status.mismatch, { worker: PROTOCOL_VERSION + 1, bridge: PROTOCOL_VERSION });
  assert.ok(status.since !== undefined, '`since` stamps when the mismatch was first seen');
  assert.equal(client.everConnected, false, 'no compatible handshake ever happened');

  // The client re-dials the same stale worker every RETRY_MS.
  await sleep(LOST_MS);
  assert.equal(statuses.length, 1, 'one mismatch message, not one per retry');
  assert.equal(lostCount, 0, 'the outage clock never started, so onWorkerLost cannot fire');
});

test('a worker restarted on a new build publishes a status update', async (t) => {
  const worker = await startFakeWorker({ appVersion: '0.2.0' });
  const statuses: WorkerStatus[] = [];
  const client = startClient(
    () => {},
    (s) => statuses.push(s),
  );
  t.after(() => client.dispose());

  // The first hello is itself a change: the seeded status carries no version, so
  // the browsers are told which build answered rather than waiting for an outage.
  await until(() => statuses.length === 1, 'first-hello status');
  assert.deepEqual(statuses[0], { connected: true, version: '0.2.0' });

  // A dogfooding restart: the worker comes back on a new build well inside the
  // outage deadline, so `connected` and `since` never move. Without `version` in
  // the comparison this transition would publish nothing and the Updates pane
  // would keep naming the old build.
  worker.close();
  const restarted = await startFakeWorker({ appVersion: '0.2.1' });
  t.after(() => restarted.close());

  await until(() => statuses.length === 2, 'version-change status');
  assert.deepEqual(statuses[1], { connected: true, version: '0.2.1' });
  assert.equal(client.status.version, '0.2.1');
});

test('a worker too old to report its build is connected with no version', async (t) => {
  const worker = await startFakeWorker();
  t.after(() => worker.close());
  const client = startClient(() => {});
  t.after(() => client.dispose());

  await until(() => client.everConnected, 'fake worker hello');
  // Absent, not undefined-valued: the field is optional on the wire too.
  assert.deepEqual(client.status, { connected: true });
});
