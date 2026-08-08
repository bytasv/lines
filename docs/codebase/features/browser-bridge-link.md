# Browser–bridge link

## Purpose

The contract between a browser connection and the bridge: what the bridge is
allowed to call on a connection, how it protects itself from a slow client, and
how the two sides discover they speak different versions.

Groundwork for hosting Lines remotely. Three things had to change before a
connection could arrive over anything other than a direct loopback socket:

- `handleConnection` took a concrete `ws.WebSocket`, so nothing else could be
  handed to it,
- `broadcast` sent unconditionally into an unbounded send buffer — invisible on
  loopback, unbounded memory growth over a network,
- the two halves always deployed together, so neither could say which contract it
  spoke.

## Entry points

- `server/src/index.ts` — `handleConnection`, the `hello` payload
- `server/src/userContext.ts` — `broadcast`
- `web/src/ws.ts` — the client's `hello` handling

## Important files

- `server/src/userContext.ts` — `BrowserLink`, `linkSendAction`, `broadcast`
- `server/src/index.ts` — `BRIDGE_VERSION`, per-socket handlers
- `shared/types.ts` — `APP_PROTOCOL_VERSION`, `BridgeInfo`, `hello.bridge`
- `web/src/store.ts` — `bridge`, `protocolSkew`

## Important symbols

- `BrowserLink` — the whole surface the bridge uses on a connection:
  `send`/`close`/`terminate`/`on('message'|'close'|'error')`/`readyState`/`bufferedAmount`
- `LINK_OPEN` — `WebSocket.OPEN` inlined, so implementations need no `ws` import
- `linkSendAction(msg, bufferedAmount)` — `'send' | 'skip' | 'close'`
- `APP_PROTOCOL_VERSION` / `BridgeInfo` / `hello.bridge`
- `protocolSkew` — client-side flag, set when the bridge's contract differs

## Data flow

A connection arrives, is gated on Clerk, is added to `ctx.sockets`, and receives
`hello` — which carries `bridge: { version, appProtocol }` alongside the full
state snapshot. Every later state change fans out through `broadcast`, which
consults `linkSendAction` per link before sending.

The client compares `hello.bridge.appProtocol` against its own
`APP_PROTOCOL_VERSION` and records `protocolSkew`. Nothing throws on a message
type it does not recognise: `applyServerMessage` has no `default` case, so an
unknown type falls through untouched.

## Dependencies

`BrowserLink` is structural, so a real `ws.WebSocket` satisfies it with no
adapter. Nothing else depends on this feature yet — the relay transport that
will supply non-socket links is not built.

## Tests

- `server/src/browserLink.test.ts` — `LINK_OPEN` matches `WebSocket.OPEN`; a real
  `ws.WebSocket` satisfies the interface; a plain object does too
- `server/src/broadcastBackpressure.test.ts` — the full `linkSendAction` policy

## Business rules

- Stream deltas are the only droppable traffic. They are never persisted and the
  browser refetches the transcript on reconnect, so losing one costs a
  partially-typed token rather than state. This is the worker's `OUTBOX_CAP` rule
  at the other end of the same pipe.
- Above the high-water mark a link sheds stream deltas but still gets every
  critical message.
- Above the hard limit the link is closed outright. Safe by construction: `hello`
  is a complete state snapshot, so a reconnect resyncs whatever was missed.
- Thresholds (4 MB / 32 MB) are deliberately far above any loopback burst, so
  local development never reaches them.
- An absent `hello.bridge` means a bridge older than the field, which counts as
  skew.
- `hello` also carries an optional `worker: WorkerStatus` (bridge<->worker link
  health — see [interrupted-turn-recovery](interrupted-turn-recovery.md)), and a
  `workerStatus` message broadcasts later transitions. Neither bumped
  `APP_PROTOCOL_VERSION`: both are additive and `applyServerMessage` has no
  `default` case, so an older client simply ignores `workerStatus` and an absent
  `hello.worker` degrades to "no banner" — the same tolerance `hello.bridge`
  already relies on.

## Architectural rules

- `BrowserLink` covers only what the bridge genuinely calls. Every addition is
  another thing an alternative transport has to implement.
- `close()` must move `readyState` off `LINK_OPEN` synchronously — `broadcast`
  relies on that to avoid re-closing the same wedged link on every message.
- Removal from `ctx.sockets` is owned solely by the `'close'` handler, including
  on the hard-limit path.
- A per-socket `'error'` listener is mandatory: an unhandled `'error'` on an
  EventEmitter throws and takes the bridge down. Loopback hides this; over a
  network, per-socket errors are routine. A non-EventEmitter implementation (a
  plain object with stored callbacks) avoids the footgun entirely.
- `linkSendAction` is pure and exported so the policy is testable without a
  socket.
- `APP_PROTOCOL_VERSION` is bumped only for browser↔bridge changes; the
  bridge↔worker `PROTOCOL_VERSION` in `workerProtocol.ts` is a separate contract
  on its own numbering.
- `hello.bridge` is optional in the type. Once the web app is hosted it will meet
  bridges older than itself, and an absent field is exactly that case.

## Related decisions

- [local-port-discovery](local-port-discovery.md) — how a client finds the bridge
  in the first place
