import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
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
 *  anyone presenting the right token — enough for WorkerClient to connect. */
function startFakeWorker(): Promise<{ close: () => void }> {
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
      ws.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, live: [] }));
    });
  });
}

function startClient(onWorkerLost: () => void) {
  return new WorkerClient(
    {
      onHello: () => {},
      onEvent: () => {},
      onEnded: () => {},
      onRpc: () => {},
      onRpcCancel: () => {},
      onWorkerLost,
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
