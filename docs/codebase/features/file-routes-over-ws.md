# Workspace reads over the WebSocket

## Purpose

File contents, directory listings, the docs bundle, `@mention` file search,
stored attachments, and previewable media (images, video, audio, pdf) travel over the browser's existing WebSocket instead of the
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
  `useFileContent`, `useAttachmentUrl`, `useMediaUrl`
- `web/src/components/FilesView.tsx` — `FileContentView` sends media paths to
  `MediaView` before any text fetch
- `server/src/index.ts` — the `fileRequest` case in `handleMessage`

## Important files

- `server/src/fileRoutes.ts` — every handler, as pure functions
- `server/src/workspacePaths.ts` — the root containment check, unchanged
- `web/src/ws.ts` — `fileRequest`, the pending-request map
- `shared/types.ts` — `FileRequestKind`, `FileRequestParams`, `AttachmentBody`,
  `MediaChunkBody`
- `web/src/lib/language.ts` — `mediaKindFor`, the extension → image/video/audio/pdf map
- `web/src/components/Transcript.tsx` — `AttachmentTile`

## Important symbols

- `handleFileRequest(ctx, kind, params, access)` → `Promise<{ status, body }>`
  — async since [session-change-tracking](session-change-tracking.md) added
  two kinds that read git; every other handler still resolves synchronously
- `fileRequest(kind, params)` — client side, promise keyed by `reqId`
- `useAttachmentUrl(rel)` — base64 → blob URL, revoked on unmount
- `useMediaUrl(path)` — pulls `media` chunks sequentially into one blob URL,
  reports progress, stops and revokes on unmount
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

Media (`media` kind) is pulled in chunks, not one frame: the client requests
`offset`/`length` slices one after another until it has the file's `size`, then
builds a `Blob`. Each reply carries the whole file's `size` so the client knows
when to stop. A separate kind (rather than a new body on `file`) keeps version
skew safe: an old bridge answers a bare 400, which the client shows as "restart
or update the bridge". `file` is unchanged, so text and unknown binaries still
get 415 "Binary files cannot be previewed.".

Two search kinds ride the same route table: `grep` (file contents, see
[find-in-files](find-in-files.md)) and `sessionSearch` (transcripts, see
[session-search](session-search.md)). Both share `buildMatcher` from
`shared/types.ts`; an invalid regex returns a 400 with an `invalidRegex` body.

## Dependencies

Reuses `resolveWorkspacePath`/`workspaceRoots` for containment (including the
`isPlanPath` exception) and `searchFilesAcross`/`collectDocs` unchanged. Requires
an open socket — there is no unauthenticated fallback.

## Tests

- `server/src/fileRoutes.test.ts` — every route: containment, size cap, binary
  rejection, all-or-nothing `find`, attachment traversal, unknown kind, and
  `media` chunking, clamping, 403/404/413/415 and bad-offset 400
- `server/src/index.planFile.test.ts` — the plan-directory exception, unchanged

## Business rules

- `status` keeps using HTTP codes. The client already maps 403/404/413/415 to
  user-facing messages, and they name these outcomes as well as anything else.
- A request made while disconnected rejects immediately; in-flight requests reject
  on close rather than hanging forever.
- `find` stays all-or-nothing across roots: a partial result reads as "no match
  here" and would silently hide a whole folder from the mention list.
- `grep` is all-or-nothing across roots like `find`; `sessionSearch` clamps every
  session id through `sessionInReach`.
- Attachments are capped at the same 2 MB as `/file` was.
- `media` serves only an allowlist of browser-renderable extensions (images,
  mp4/webm/mov/m4v, mp3/wav/ogg/m4a/flac, pdf); anything else is 415. A request
  is clamped to 1 MB, files over 200 MB are 413, and an offset outside the file
  is 400. Chunks go one at a time so live transcript frames interleave on the
  shared socket and relay instead of waiting behind one large frame.
- The browser buffers the whole file (chunks plus Blob), so the 200 MB cap bounds
  memory; video plays only after every chunk arrives.

## Architectural rules

- The handlers are pure `{ status, body }` (or `Promise<{ status, body }>`)
  functions in their own module, not `http.ServerResponse` writers — that is
  what lets them serve a relay channel, and what makes them testable without a
  socket (index.ts listens on import).
- `fileResponse` is handled in `ws.ts` before `applyServerMessage` and returns
  early; the store never sees it.
- The bridge's only remaining HTTP surface is its status page, so `corsFor`,
  `httpUserId`, `WEB_ORIGIN` and `withAuthToken` are all deleted rather than
  retained "just in case" — each was a second auth path to keep in step.
- SVG renders through `<img>`, never inline, so its scripts do not run.
- Media blob URLs are revoked on unmount, and the chunk loop stops after the
  in-flight request.
- Attachment blob URLs are revoked when the tile unmounts; without that every
  re-render would leak a blob for the life of the page.

## Related decisions

- [hosted-machine-access](hosted-machine-access.md) — the connection these ride on
- [permissions-and-plan-mode](permissions-and-plan-mode.md) — the plan-directory
  exception in the containment check
- [session-change-tracking](session-change-tracking.md) — `sessionDiff`/
  `sessionDiffFile`, the two kinds that made dispatch async and added the
  `sessionInReach` grant clamp on top of the `readFiles` capability
