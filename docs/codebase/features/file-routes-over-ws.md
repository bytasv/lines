# Workspace reads over the WebSocket

## Purpose

File contents, directory listings, the docs bundle, `@mention` file search,
stored attachments, and previewable media (images, video, audio, pdf) travel over the browser's existing WebSocket instead of the
bridge's HTTP server. One kind, `writeFile`, goes the other way: the owner saving an edit to an existing text file.

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
  `useFileContent`, `saveFile`, `useAttachmentUrl`, `useMediaUrl`
- `web/src/components/FilesView.tsx` — `FileContentView` sends media paths to
  `MediaView` before any text fetch
- `server/src/index.ts` — the `fileRequest` case in `handleMessage`

## Important files

- `server/src/fileRoutes.ts` — every handler, as pure functions
- `server/src/workspacePaths.ts` — the root containment check (`resolveWorkspacePath`), following
  symlinks through `isRealInside`; `resolveFilePath`, the single-file routes' resolver (owner
  reaches any path, everyone else falls through to the root check)
- `server/src/autoGuard.ts` — `realPathOf`/`isRealInside`, the one symlink-following containment
  implementation the routes share with the auto-mode guard
- `server/src/contentSearch.ts` — `grep`'s symlink skip (`linkedDirs`, `isLink`)
- `web/src/ws.ts` — `fileRequest`, the pending-request map
- `shared/types.ts` — `FileRequestKind`, `FileRequestParams`, `AttachmentBody`,
  `MediaChunkBody`, `FileContentResponse`, `FileWriteResponse`
- `web/src/lib/language.ts` — `mediaKindFor`, the extension → image/video/audio/pdf map
- `web/src/components/Transcript.tsx` — `AttachmentTile`

## Important symbols

- `handleFileRequest(ctx, kind, params, access)` → `Promise<{ status, body }>`
  — async since [session-change-tracking](session-change-tracking.md) added
  two kinds that read git; every other handler still resolves synchronously
- `fileRequest(kind, params)` — client side, promise keyed by `reqId`
- `useAttachmentUrl(rel)` — base64 → blob URL, revoked on unmount
- `saveFile(path, content, expectedMtimeMs?)` — the `writeFile` call; a 409 comes
  back as a typed `{ conflict: true, mtimeMs }` result instead of a thrown error
- `useMediaUrl(path)` — pulls `media` chunks sequentially into one blob URL,
  reports progress, stops and revokes on unmount
- `ClientMessage.fileRequest` / `ServerMessage.fileResponse`
- `resolveFilePath(ctx, raw, access)` — used only by `file`, `media` and `writeFile`; never by
  listing or search routes
- `soleTarget` / `grantedReal` — a granted path as named (`abs`, for anything
  echoed back) and as touched (`real`: its realpath, gated again there); every
  single-path route reads or writes `real`
- `readAttachment` — stored attachments, scoped to the session they sit under
  through `sessionInReach`

## Data flow

The client sends `{ type: 'fileRequest', reqId, kind, params }` and holds a
promise against `reqId`. The bridge dispatches through `handleFileRequest` and
replies `{ type: 'fileResponse', reqId, status, body }` **on the originating
link** — never via broadcast, since two tabs each have their own in-flight ids.
`ws.ts` settles the promise and returns early, so a response never reaches the
store: it is a point-to-point reply, not application state.

Attachments come back as base64 and become blob URLs client-side, symmetric with
the upload path, which was already base64.

Every path is checked where it really lands. For a guest that means a symlink inside a granted
root cannot point anywhere on the host; the owner's single-file routes (`file`, `media`,
`writeFile`) go through `resolveFilePath` and reach any path, but still touch only the real path
they checked. `resolveWorkspacePath` requires the path
inside a root both as written and once links are followed (`isRealInside`, the
auto-mode guard's own helper), and each single-path kind — `file`, `tree`,
`docs`, `media`, `writeFile`, `sessionDiffFile` — then touches only the resolved
real path (`grantedReal`), re-gated there. Touching the path as named would follow
its links a second time, after the check, so a link swapped in between could
redirect the access. `attachment` does the same against the attachments root, and
then reads the session id off where the file really is: attachments sit under
`<sessionId>/`, and that session is the grant (`sessionInReach`). `grep` cannot
take the same route per file — it walks thousands — so it lets only the
candidates that are a symlink, or sit below a linked directory (`isLink`,
`linkedDirs`, memoized per directory), pay for a realpath, and skips any that
lands outside its root.

Media (`media` kind) is pulled in chunks, not one frame: the client requests
`offset`/`length` slices one after another until it has the file's `size`, then
builds a `Blob`. Each reply carries the whole file's `size` so the client knows
when to stop. A separate kind (rather than a new body on `file`) keeps version
skew safe: an old bridge answers a bare 400, which the client shows as "restart
or update the bridge". `file` is unchanged, so text and unknown binaries still
get 415 "Binary files cannot be previewed.".

Writing (`writeFile`) is the one non-read kind. `file` replies carry the file's
`mtimeMs`; the editor sends it back as `expectedMtimeMs`. If the file's mtime has
moved on (the agent edited it meanwhile) the bridge answers 409 with the current
`mtimeMs` and writes nothing, and the UI offers Overwrite (resend without
`expectedMtimeMs`) or Reload. The write goes to a sibling temp file that is
chmod'ed to the original's mode and renamed over the target, so a crash never
leaves a truncated file and a symlink stays a symlink. Version skew works like
`media`: an old bridge answers a bare 400, shown as "restart or update it".

Two search kinds ride the same route table: `grep` (file contents, see
[find-in-files](find-in-files.md)) and `sessionSearch` (transcripts, see
[session-search](session-search.md)). Both share `buildMatcher` from
`shared/types.ts`; an invalid regex returns a 400 with an `invalidRegex` body.

## Dependencies

Reuses `resolveWorkspacePath`/`workspaceRoots` for containment (including the
owner-only `isPlanPath` exception) and `resolveFilePath` for the owner's single-file reach, `realPathOf`/`isRealInside` from
`server/src/autoGuard.ts` for following symlinks, and `searchFilesAcross`/
`collectDocs` unchanged. Requires an open socket — there is no unauthenticated
fallback.

## Tests

- `server/src/fileRoutes.test.ts` — every route: containment, size cap, binary
  rejection, all-or-nothing `find`, attachment traversal, unknown kind, and
  `media` chunking, clamping, 403/404/413/415 and bad-offset 400; `writeFile`
  containment, symlink escape, 409, mode preservation and temp-file cleanup; a
  symlink that leaves its root refused for `file`, `media`, `tree`, `writeFile`,
  `sessionDiffFile` and `attachment` (one that stays is served); a read touching
  only the real path it checked; `grep` skipping a symlink git lists and a tracked
  file under a since-linked directory; a session-scope guest reading its own
  sessions' attachments and no others', not by `..` nor through a planted link
- `server/src/guestAccess.test.ts` — a Full-share guest still gets 403 on `writeFile`; session and
  machine guests get 403 on `file`, `media` and `writeFile` outside their session cwds (`/tmp`, `~`,
  a host project that is not theirs)
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
- The owner's `file`, `media` and `writeFile` reach any path on the host (`/tmp`, `~/…`, another
  project), through `resolveFilePath`: it is their own disk over their own authenticated socket,
  the same reach the agent has. A guest, machine or session scope, stays clamped to their session
  cwds. `tree`, `docs`, `find`, `grep`, `sessionSearch`, `sessionDiffFile` and `attachment` stay
  root-scoped for everyone, so the sidebar never walks `/`.
- `writeFile` is owner-only, enforced in `handleFileRequest` and the handler. The
  socket gate for every file kind is the `readFiles` capability, so without this
  check a guest with View or Full access could write to the host's disk; there is
  no `ShareCaps` flag for it.
- For a guest, every read, write and media request is served from where its path really
  lands: inside a granted root both as written and once symlinks are followed,
  and then read or written at that resolved real path, gated again there — a
  prefix check alone lets a symlink inside the project point outside it. A link
  that cannot be followed is 403 like one that leaves the root. The owner's single-file routes skip
  the root check but still read and write the real path they checked; listing and search stay
  root-scoped for everyone.
- `writeFile` writes only existing regular text files (404 otherwise); no
  create, rename or delete. Content over 2 MB is 413, a NUL byte is 415, missing
  content is 400, a stale `expectedMtimeMs` is 409.
- An attachment is served only to a connection that reaches its session
  (`sessionInReach`): a session-scope guest reads its own sessions' attachments
  and no others', a machine guest and the owner every session's. The session is
  read off where the file really is, so a link planted in the attachments
  directory, or from one session's folder into another's, is refused.
- `grep` never searches through a symlink that leaves its root — git lists a
  symlink by its own path, and its index can name a file under a directory since
  swapped for a link.
- mtime conflict detection misses same-millisecond writes on coarse-mtime
  filesystems; accepted for basic editing. Content is round-tripped as UTF-8, so a
  BOM or non-UTF-8 file can change on save.
- A save made while a turn runs in the session's cwd falls inside that turn's git
  snapshot window, so the session diff attributes it to the agent.
- The browser buffers the whole file (chunks plus Blob), so the 200 MB cap bounds
  memory; video plays only after every chunk arrives.

## Architectural rules

- The handlers are pure `{ status, body }` (or `Promise<{ status, body }>`)
  functions in their own module, not `http.ServerResponse` writers — that is
  what lets them serve a relay channel, and what makes them testable without a
  socket (index.ts listens on import).
- `fileResponse` is handled in `ws.ts` before `applyServerMessage` and returns
  early; the store never sees it.
- Containment is one implementation: `realPathOf`/`isRealInside` are exported
  from `server/src/autoGuard.ts` and used by `resolveWorkspacePath`, the
  attachment route and `grep`, so the routes follow links exactly the way the
  auto-mode guard does. The route-local `realInsideGrant`, which re-checked only
  `writeFile`, is gone.
- `resolveFilePath` is for single-file routes only. Pointing `tree`, `find` or `grep` at it would
  let the sidebar and search walk the whole disk.
- A route touches the path it checked (`grantedReal`), never the path as named,
  so the window between the containment check and the read or write cannot be
  used to swap a link in.
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
  exception in the containment check, and `realPathOf`/`isRealInside`, the
  guard's symlink-following containment these routes reuse
- [session-change-tracking](session-change-tracking.md) — `sessionDiff`/
  `sessionDiffFile`, the two kinds that made dispatch async and added the
  `sessionInReach` grant clamp on top of the `readFiles` capability
