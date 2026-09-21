/**
 * Serve Monaco from this bundle instead of from a CDN.
 *
 * `@monaco-editor/react` defaults to loading the editor from
 * `cdn.jsdelivr.net` at runtime. That is a second, independent supply chain into
 * the page that holds the encryption keys: whoever can serve that script can
 * read everything the user types, regardless of how the socket is encrypted. It
 * is also what made a real Content-Security-Policy impossible, since `script-src`
 * had to allow a third-party origin.
 *
 * So Monaco is bundled. It costs bundle size, and buys a page whose executable
 * code all comes from one origin — which is the precondition for the CSP in
 * `deploy/docker/web-nginx.conf`.
 *
 * Only the core editor worker is wired up, deliberately. The language workers
 * (TypeScript, JSON, CSS, HTML) exist for IntelliSense; every Monaco surface
 * here is a viewer or a diff, where syntax highlighting comes from the Monarch
 * grammars in the main bundle and a language worker would be several more
 * megabytes for nothing.
 *
 * Imported for its side effects by each of the four modules that mount an editor
 * — MonacoPreviewModal, MonacoDiffModal, SessionDiffModal, FilesView — and not
 * by `main.tsx`, which would pull all of Monaco into the entry chunk and delay
 * the first paint of every screen that has no editor on it.
 *
 * The ordering invariant still holds, and comes from module evaluation rather
 * than from import position: each of those four is reached through
 * `React.lazy`, so this module runs when its chunk evaluates, which is before
 * the component in that chunk can render. `loader.config` still wins the race
 * against the first mount. A module that mounts an editor without this import
 * falls back to the jsDelivr CDN — which the CSP then blocks, so it fails
 * visibly rather than silently.
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
// The path goes through the package's own `exports` map (`./*` -> `./esm/vs/*.js`),
// which is why it is not the `esm/vs/...` path the older recipes use — that form
// no longer resolves in monaco-editor 0.56.
import editorWorker from 'monaco-editor/editor/editor.worker?worker';

self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

loader.config({ monaco });
