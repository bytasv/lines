import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import {
  connectionPolicy,
  hostAllowed,
  listenHost,
  upgradeVerdict,
  verifyClient,
  type ConnectionPolicy,
} from './connectionPolicy.ts';

/**
 * Who may open a direct socket. The bridge is remote code execution for whoever
 * holds a socket, so every case worth pinning is a stranger getting in: a LAN
 * peer, a website the user visited, a page that rebound its domain to 127.0.0.1.
 */

const loopback = connectionPolicy({});
const lan = connectionPolicy({
  LINES_BRIDGE_HOST: '0.0.0.0',
  LINES_BRIDGE_ALLOWED_ORIGINS: 'http://192.168.1.20:5173, https://lines.example.com/',
});

describe('listenHost', () => {
  test('loopback by default, and localhost pinned to IPv4', () => {
    assert.deepEqual(listenHost({}), { host: '127.0.0.1' });
    assert.deepEqual(listenHost({ LINES_BRIDGE_HOST: 'localhost' }), { host: '127.0.0.1' });
    assert.deepEqual(listenHost({ LINES_BRIDGE_HOST: '127.0.0.1' }), { host: '127.0.0.1' });
  });

  test('another loopback address is refused: every local caller dials 127.0.0.1', () => {
    assert.deepEqual(listenHost({ LINES_BRIDGE_HOST: '::1' }), { host: '127.0.0.1', refused: '::1' });
    assert.deepEqual(listenHost({ LINES_BRIDGE_HOST: '127.0.0.2' }), { host: '127.0.0.1', refused: '127.0.0.2' });
  });

  test('every interface only when asked for by name', () => {
    assert.deepEqual(listenHost({ LINES_BRIDGE_HOST: '0.0.0.0' }), { host: '0.0.0.0' });
    assert.deepEqual(listenHost({ LINES_BRIDGE_HOST: '::' }), { host: '::' });
  });

  test('anything else falls back to loopback and says so', () => {
    assert.deepEqual(listenHost({ LINES_BRIDGE_HOST: '192.168.1.20' }), { host: '127.0.0.1', refused: '192.168.1.20' });
    assert.deepEqual(listenHost({ LINES_BRIDGE_HOST: 'evil.example' }), { host: '127.0.0.1', refused: 'evil.example' });
  });

  test('the policy follows the bind', () => {
    assert.equal(loopback.loopbackOnly, true);
    assert.equal(lan.loopbackOnly, false);
    assert.equal(loopback.direct, true);
    assert.equal(connectionPolicy({ LINES_BRIDGE_DIRECT: '0' }).direct, false);
    // Canonicalised, so a trailing slash or a space in the env var still matches.
    assert.deepEqual([...lan.allowedOrigins], ['http://192.168.1.20:5173', 'https://lines.example.com']);
  });
});

describe('hostAllowed', () => {
  const cases: [string | undefined, boolean][] = [
    ['127.0.0.1:8787', true],
    ['localhost:8787', true],
    ['LOCALHOST', true],
    ['[::1]:8787', true],
    ['127.1.2.3', true],
    // A rebinding page sends its own name.
    ['evil.example:8787', false],
    ['127.0.0.1.evil.example', false],
    ['localhost.evil.example', false],
    ['sub.localhost:8787', false],
    ['localhost.:8787', false],
    // Routed to loopback by some browsers, and never a page of ours.
    ['0.0.0.0:8787', false],
    ['192.168.1.20:8787', false],
    [undefined, false],
    ['', false],
  ];
  for (const [host, ok] of cases) {
    test(`${JSON.stringify(host)} on a loopback bind → ${ok ? 'allowed' : 'refused'}`, () => {
      assert.equal(hostAllowed(host, loopback), ok);
    });
  }

  test('a wildcard bind is reached by its LAN address, so the Host check stands aside', () => {
    assert.equal(hostAllowed('192.168.1.5:8787', lan), true);
  });
});

describe('upgradeVerdict', () => {
  type Row = [
    name: string,
    req: { origin?: string; host?: string; remoteAddress?: string },
    policy: ConnectionPolicy,
    expected: true | 403 | 421,
  ];
  const local = { host: '127.0.0.1:8787', remoteAddress: '127.0.0.1' };
  const rows: Row[] = [
    ['the dev server page', { ...local, origin: 'http://localhost:5173' }, loopback, true],
    ['the desktop window in local mode', { ...local, origin: 'http://127.0.0.1:51234' }, loopback, true],
    ['an IPv6 loopback page', { ...local, origin: 'http://[::1]:5173', remoteAddress: '::1' }, loopback, true],
    ['a non-browser client on this machine', local, loopback, true],
    ['a website the user visited', { ...local, origin: 'https://evil.example' }, loopback, 403],
    ['a sandboxed frame or file:// page', { ...local, origin: 'null' }, loopback, 403],
    ['a file:// origin spelled out', { ...local, origin: 'file://' }, loopback, 403],
    ['a lookalike loopback host', { ...local, origin: 'http://localhost.evil.example' }, loopback, 403],
    ['a rebinding page', { origin: 'http://evil.example:8787', host: 'evil.example:8787', remoteAddress: '127.0.0.1' }, loopback, 421],
    ['the phone, without the opt-in origin', { origin: 'http://192.168.1.99:5173', host: '192.168.1.5:8787', remoteAddress: '192.168.1.99' }, lan, 403],
    ['the phone, with it', { origin: 'http://192.168.1.20:5173', host: '192.168.1.5:8787', remoteAddress: '192.168.1.20' }, lan, true],
    // On a wildcard bind a LAN machine's own localhost page must not pass for ours.
    ['a LAN peer’s localhost page', { origin: 'http://localhost:3000', host: '192.168.1.5:8787', remoteAddress: '192.168.1.99' }, lan, 403],
    ['a LAN peer with no origin', { host: '192.168.1.5:8787', remoteAddress: '192.168.1.99' }, lan, 403],
    ['anything at all when direct sockets are off', { ...local, origin: 'http://localhost:5173' }, connectionPolicy({ LINES_BRIDGE_DIRECT: '0' }), 403],
  ];
  for (const [name, req, policy, expected] of rows) {
    test(`${name} → ${expected === true ? 'allowed' : expected}`, () => {
      const verdict = upgradeVerdict(req, policy);
      if (expected === true) assert.deepEqual(verdict, { ok: true });
      else {
        assert.equal(verdict.ok, false);
        assert.equal(!verdict.ok && verdict.status, expected);
      }
    });
  }
});

/**
 * The same check through a real listener: the glue (`verifyClient`) is what the
 * bridge runs, so a refusal here is a refusal there. Bound to 127.0.0.1 exactly
 * as the bridge is by default.
 */
describe('a real socket', () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const wss = new WebSocketServer({ server, verifyClient: verifyClient(loopback) });
  wss.on('connection', (ws) => ws.send('hello'));
  const listening = new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
  after(() => {
    wss.close();
    server.close();
  });

  /** Dial and report the HTTP status of a refused upgrade, or 101 for an accepted one. */
  async function dial(headers: Record<string, string>): Promise<number> {
    const port = await listening;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
      ws.once('open', () => {
        ws.close();
        resolve(101);
      });
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('error', (err) => reject(err));
    });
  }

  test('this machine’s own page gets in', async () => {
    assert.equal(await dial({ origin: 'http://localhost:5173' }), 101);
  });

  test('a cross-site page is refused with 403, before any hello', async () => {
    assert.equal(await dial({ origin: 'https://evil.example' }), 403);
  });

  test('a rebinding Host is refused with 421', async () => {
    assert.equal(await dial({ origin: 'http://evil.example:8787', host: 'evil.example:8787' }), 421);
  });
});
