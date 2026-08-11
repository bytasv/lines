# Documentation reader

## Purpose

An in-app reader for a project's `docs/**` markdown corpus: a doc tree, an `index.json`-driven feature-card home, full-text search, and cross-links that navigate inside the reader instead of opening the source-file preview.

## Entry points

- `web/src/components/ProjectTabs.tsx` (header books icon)
- `web/src/components/SettingsModal.tsx` (Documentation section)
- `/docs/*` route (direct URL / deep link)

## Important files

- `server/src/docsBundle.ts` — `collectDocs`, the recursive markdown walk
- `server/src/fileRoutes.ts` — the `docs` request handler, reached over the WebSocket (see [file-routes-over-ws](file-routes-over-ws.md))
- `shared/types.ts` — `DocFile`, `DocsResponse`, `resolveDocLink`, `docTitle`, `docSummary`, `searchDocs`
- `web/src/lib/files.ts` — `docsRootFor`, `fetchDocs`, `useDocs`
- `web/src/lib/features.ts` — `loadFeatures`/`invalidateFeatures` (extracted from `mentions.ts`, now shared with the reader)
- `web/src/lib/docs.ts` — `toDocTreeNodes`, `ancestorDirs`, `featureCards`, `unindexedDocs`
- `web/src/components/docs/DocsPage.tsx`, `DocsSidebar.tsx`, `DocsHome.tsx`, `DocView.tsx`
- `web/src/components/Markdown.tsx` — optional `onLinkClick` prop
- `web/src/App.tsx` — `/docs/*` route, hoisted overlay modals

## Important symbols

- `collectDocs`, `DocFile`, `DocsResponse`
- `resolveDocLink`, `DocLinkTarget`, `normalizeDocPath`, `docDirname`, `isExternalHref`
- `docTitle`, `docSummary`, `searchDocs`, `DocSearchHit`
- `useDocs`, `fetchDocs`, `docsRootFor`
- `toDocTreeNodes`, `ancestorDirs`, `featureCards`, `FeatureCard`, `unindexedDocs`
- `Markdown.onLinkClick`

## Data flow

Opening `/docs` (or any `/docs/<rel>.md`) fetches the whole `docs/**` markdown corpus in one request: `GET /docs?path=<project>/docs` walks the tree server-side (`collectDocs`) and returns `{root, docs[], truncated}`. Everything downstream — the sidebar tree, the card home (paired with a separately-fetched `docs/codebase/index.json` via `loadFeatures`), keystroke search (`searchDocs`), and doc-to-doc navigation (`resolveDocLink`) — runs client-side against that one bundle; there is no per-navigation refetch and no server-side cache. A link inside a rendered doc reaches `Markdown`'s `onLinkClick`, which the reader wires to `resolveDocLink`: a markdown target becomes a `navigate()` call (URL changes, browser Back works), anything else opens the existing file-preview modal or an external tab.

## Dependencies

- `docs/codebase/index.json` (optional; missing/unparseable degrades to a plain document list)
- The bridge's existing workspace-root gate (`resolveWorkspacePath`)

## Tests

- `server/src/docsBundle.test.ts`
- `server/src/docsLinks.test.ts`
- `server/src/docsSearch.test.ts`

No front-end tests — `web/` has no test runner; the pure logic (link resolution, title/summary extraction, search ranking) lives in `shared/types.ts` specifically so `node:test` can reach it.

## Business rules

- The corpus and `docs/codebase/index.json` are allowed to disagree: an index entry whose `doc` is missing from the bundle still renders as a card (name/purpose are useful on their own) with a "no doc" badge; a bundle doc no entry claims lists under "Other documents"; a missing/unparseable index degrades to a plain "All documents" list, not an error page.
- A markdown link target always resolves to `kind: 'doc'` and opens inside the reader — even when the target isn't in this corpus — so a broken cross-link surfaces as a "not in this corpus" panel rather than a source-preview 404.
- A link that escapes the docs root, or isn't markdown, opens the existing file-preview modal instead.
- No project open, or no `docs/` folder in the active project, shows an empty state instead of an error boundary.

## Architectural rules

- One bundle request powers every reader feature; there is deliberately no per-file `/file` fan-out and no separate search route.
- `docs` sits inside the same `resolveWorkspacePath` gate as `file`, `tree`, and `find` — no bypass for the reader.
- `collectDocs` never follows symlinks (files or directories): `readdirSync`'s `Dirent.isFile()`/`isDirectory()` are both false for a symlink, which is what keeps a `docs/key.md -> ~/.ssh/id_rsa` link from being read through an otherwise-allowed root.
- Pure doc logic (link resolution, title/summary extraction, search ranking) lives in `shared/types.ts`, not a new module, because that is the one place both `node:test` and the browser can import from.
- `Markdown` gained one optional `onLinkClick` prop rather than being forked; every transcript call site passes nothing, so its behavior is unchanged (`openFilePreview` fallback). The prop must stay referentially stable (`useCallback`) since the component is `memo`'d.
- The three global modals (`MonacoPreviewModal`, `LoginModal`, `GuardAllowlistReviewModal`) are mounted once at the `App` root instead of inside `Shell`, so a source-path click or a sign-in prompt still has something to open while on `/docs`.

## Related decisions

- [prompt-mentions](prompt-mentions.md)
- [transcript-rendering](transcript-rendering.md)
