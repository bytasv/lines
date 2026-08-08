import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { LINK_OPEN, type BrowserLink } from './userContext.ts';

/**
 * BrowserLink is the structural contract that lets a connection reach
 * `handleConnection` over something other than a direct socket. Two things can
 * drift silently, and both are cheap to pin down here.
 */

test('LINK_OPEN matches the ws constant it inlines', () => {
  // broadcast() gates every send on `readyState === LINK_OPEN`. If ws ever
  // renumbered OPEN, that comparison would quietly stop matching and this
  // user's browsers would go silent with no error anywhere.
  assert.equal(LINK_OPEN, WebSocket.OPEN);
});

test('a real ws.WebSocket satisfies BrowserLink', () => {
  // Compile-time assertion: if the interface grows a member `ws` lacks, tsc
  // fails here rather than at the wss.on('connection') call site.
  const satisfies = (link: BrowserLink) => link;
  const asLink: (s: WebSocket) => BrowserLink = (s) => satisfies(s);
  assert.equal(typeof asLink, 'function');
});

test('a plain object satisfies BrowserLink without importing ws', () => {
  // The point of the interface: a relay channel is an ordinary object with two
  // stored callbacks, deliberately NOT an EventEmitter (which would reintroduce
  // the throw-on-unhandled-'error' footgun the real socket has).
  const sent: string[] = [];
  const handlers: Record<string, ((arg?: unknown) => void) | undefined> = {};
  let closedWith: number | undefined;

  // `on` mirrors ws's overloads so call sites keep their inferred argument
  // types; an implementer restates them once, as here.
  function on(event: 'message', cb: (raw: unknown) => void): BrowserLink;
  function on(event: 'close', cb: () => void): BrowserLink;
  function on(event: 'error', cb: (err: Error) => void): BrowserLink;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- canonical
  // overload-implementation signature; the overloads above are the real contract.
  function on(event: string, cb: (...args: any[]) => void): BrowserLink {
    handlers[event] = cb;
    return link;
  }

  const link: BrowserLink = {
    send: (data) => sent.push(data),
    close: (code) => {
      closedWith = code;
    },
    terminate: () => {
      closedWith = 1006;
    },
    on,
    readyState: LINK_OPEN,
    bufferedAmount: 0,
  };

  link.send('hello');
  assert.deepEqual(sent, ['hello']);

  link.on('message', (raw) => sent.push(`got:${String(raw)}`));
  handlers.message?.('ping');
  assert.deepEqual(sent, ['hello', 'got:ping']);

  link.close(1008, 'unauthorized');
  assert.equal(closedWith, 1008);

  link.terminate();
  assert.equal(closedWith, 1006);
});
