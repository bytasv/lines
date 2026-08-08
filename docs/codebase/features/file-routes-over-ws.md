# Workspace reads over the WebSocket

## Purpose

File contents, directory listings, the docs bundle, `@mention` file search, and
stored attachments travel over the browser's existing WebSocket instead of the
bridge's HTTP server.

They used to be `GET /file`, `/tree`, `/find`, `/docs` and `/attachments/*` with
the Clerk token in the query string. That put a live credential into URLs — and
so into any access log or browser history along the way — and it meant the bridge
needed an HTTP surface, a CORS allowlist, and a second auth gate that had to stay
in step with the socket's.

The socket is already authenticated, so none of that is needed. It also removes
the last reason a relayed connection would need HTTP: the relay can be a pure
WebSocket multiplexer.

## Entry points

- `web/src/lib/files.ts` — `fetchTree`, `searchFiles`, `fetchDocs`,
  `useFileContent`, `useAttachmentUrl`
- `server/src/index.ts` — the `fileRequest` case in `handleMessage`

## Important files

- `server/src/fileRoutes.ts` — every handler, as pure functions
- `server/src/workspacePaths.ts` — the root containment check, unchanged
- `web/src/ws.ts` — `fileRequest`, the pending-request map
- `shared/types.ts` — `FileRequestKind`, `FileRequestParams`, `AttachmentBody`
- `web/src/components/Transcript.tsx` — `AttachmentTile`

## Important symbols

- `handleFileRequest(ctx, kind, params)` → `{ status, body }`
- `fileRequest(kind, params)` — client side, promise keyed by `reqId`
- `useAttachmentUrl(rel)` — base64 → blob URL, revoked on unmount
- `ClientMessage.fileRequest` / `ServerMessage.fileResponse`

## Data flow

The client sends `{ type: 'fileRequest', reqId, kind, params }` and holds a
promise against `reqId`. The bridge dispatches through `handleFileRequest` and
replies `{ type: 'fileResponse', reqId, status, body }` **on the originating
link** — never via broadcast, since two tabs each have their own in-flight ids.
`ws.ts` settles the promise and returns early, so a response never reaches the
store: it is a point-to-point reply, not application state.

Attachments come back as base64 and become blob URLs client-side, symmetric with
the upload path, which was already base64.

## Dependencies

Reuses `resolveWorkspacePath`/`workspaceRoots` for containment (including the
`isPlanPath` exception) and `searchFilesAcross`/`collectDocs` unchanged. Requires
an open socket — there is no unauthenticated fallback.

## Tests

- `server/src/fileRoutes.test.ts` — every route: containment, size cap, binary
  rejection, all-or-nothing `find`, attachment traversal, unknown kind
- `server/src/index.planFile.test.ts` — the plan-directory exception, unchanged

## Business rules

- `status` keeps using HTTP codes. The client already maps 403/404/413/415 to
  user-facing messages, and they name these outcomes as well as anything else.
- A request made while disconnected rejects immediately; in-flight requests reject
  on close rather than hanging forever.
- `find` stays all-or-nothing across roots: a partial result reads as "no match
  here" and would silently hide a whole folder from the mention list.
- Attachments are capped at the same 2 MB as `/file` was.

## Architectural rules

- The handlers are pure `{ status, body }` functions in their own module, not
  `http.ServerResponse` writers — that is what lets them serve a relay channel,
  and what makes them testable without a socket (index.ts listens on import).
- `fileResponse` is handled in `ws.ts` before `applyServerMessage` and returns
  early; the store never sees it.
- The bridge's only remaining HTTP surface is its status page, so `corsFor`,
  `httpUserId`, `WEB_ORIGIN` and `withAuthToken` are all deleted rather than
  retained "just in case" — each was a second auth path to keep in step.
- Attachment blob URLs are revoked when the tile unmounts; without that every
  re-render would leak a blob for the life of the page.

## Related decisions

- [browser-bridge-link](browser-bridge-link.md) — the connection these ride on
- [plan-file-auto-approve](plan-file-auto-approve.md) — the plan-directory
  exception in the containment check
