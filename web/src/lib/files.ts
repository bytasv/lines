import { useCallback, useEffect, useState } from 'react';
import type {
  AttachmentBody,
  DocsResponse,
  FileContentResponse,
  FindResponse,
  GrepResponse,
  MatchOptions,
  SessionSearchResponse,
  TreeEntry,
  TreeResponse,
} from '@lines/shared';
import { fileRequest } from '../ws';

/**
 * Workspace reads travel over the WebSocket, not HTTP — see FileRequestKind in
 * shared/types.ts. `status` still uses HTTP codes, which the maps below turn
 * into user-facing messages exactly as before.
 */
function fail(status: number, messages: Record<number, string>, fallback: string): never {
  throw new Error(messages[status] ?? `${fallback} (${status}).`);
}

const ERROR_MESSAGES: Record<number, string> = {
  403: 'Access denied — file is outside the project.',
  404: 'File not found.',
  413: 'File too large to preview.',
  415: 'Binary files cannot be previewed.',
};

export async function fetchTree(dir: string): Promise<TreeEntry[]> {
  const { status, body } = await fileRequest('tree', { paths: [dir] });
  if (status !== 200) fail(status, {}, 'Failed to list directory');
  return (body as TreeResponse).entries;
}

/**
 * Ranked file-name matches for `query` across every project root, each hit
 * relative to its own root. Gitignored files stay out unless `includeIgnored`.
 */
export async function searchFiles(
  roots: string[],
  query: string,
  limit: number,
  includeIgnored = false,
): Promise<{ root: string; rel: string }[]> {
  // One path per root — the bridge 403s if any fails to resolve.
  const { status, body } = await fileRequest('find', {
    paths: roots,
    q: query,
    limit,
    includeIgnored,
  });
  if (status !== 200) fail(status, {}, 'Failed to search files');
  return (body as FindResponse).files;
}

const SEARCH_ERROR_MESSAGES: Record<number, string> = {
  // A bare 400 is the bridge not knowing the request kind at all — one older
  // than find-in-files. An invalid regex is a 400 too, but says so in its body.
  400: 'This bridge does not support search yet — restart or update it.',
  403: 'Access denied — outside the project.',
};

function failSearch(status: number, body: unknown, fallback: string): never {
  if (status === 400 && (body as { error?: string } | undefined)?.error === 'invalidRegex') {
    throw new Error('Invalid regular expression.');
  }
  fail(status, SEARCH_ERROR_MESSAGES, fallback);
}

/**
 * Content matches for `query` across every project root, grouped by file.
 * Rejects with "Invalid regular expression." for a bad `regex` query.
 */
export async function grepFiles(
  roots: string[],
  query: string,
  opts: MatchOptions & { includeIgnored?: boolean },
): Promise<GrepResponse> {
  const { status, body } = await fileRequest('grep', { paths: roots, q: query, ...opts });
  if (status !== 200) failSearch(status, body, 'Failed to search files');
  return body as GrepResponse;
}

/**
 * Transcript matches for `query`, most recently updated session first. With
 * `sessionIds` exactly those sessions are searched; without, every session
 * under `roots`. The bridge clamps either list to the connection's grant.
 */
export async function searchSessions(
  roots: string[],
  query: string,
  opts: MatchOptions,
  sessionIds?: string[],
): Promise<SessionSearchResponse> {
  const { status, body } = await fileRequest('sessionSearch', {
    paths: roots,
    q: query,
    ...opts,
    ...(sessionIds ? { sessionIds } : {}),
  });
  if (status !== 200) failSearch(status, body, 'Failed to search sessions');
  return body as SessionSearchResponse;
}

const DOCS_ERROR_MESSAGES: Record<number, string> = {
  403: 'Access denied — the docs folder is outside the project.',
  404: 'This project has no `docs/` folder.',
};

/** The documentation corpus of a project lives under its `docs/` directory. */
export function docsRootFor(projectRoot: string): string {
  return `${projectRoot}/docs`;
}

/** The whole markdown corpus under `docsRoot`, in one request. */
export async function fetchDocs(docsRoot: string): Promise<DocsResponse> {
  const { status, body } = await fileRequest('docs', { paths: [docsRoot] });
  if (status !== 200) fail(status, DOCS_ERROR_MESSAGES, 'Failed to load documentation');
  return body as DocsResponse;
}

/**
 * Load a project's docs bundle once per project. Everything the reader does —
 * tree, cards, search, doc-to-doc navigation — runs off this one payload, so
 * `reload` is the only way it refreshes (there is no watcher).
 */
export function useDocs(projectRoot: string | null) {
  const [bundle, setBundle] = useState<DocsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!projectRoot) {
      setBundle(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    let cancelled = false;
    fetchDocs(docsRootFor(projectRoot))
      .then((data) => {
        if (!cancelled) setBundle(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setBundle(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, reloadKey]);

  return { bundle, error, loading, reload };
}

/**
 * Fetch a file's contents from the bridge; returns loading/error/content states.
 * Bumping `reloadKey` refetches the same path — used by the plan card to pick up
 * a plan revised since the card was opened last.
 */
export function useFileContent(path: string | undefined, reloadKey?: number) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) return;
    setContent(null);
    setError(null);
    let cancelled = false;
    fileRequest('file', { paths: [path] })
      .then(({ status, body }) => {
        if (cancelled) return;
        if (status !== 200) {
          setError(ERROR_MESSAGES[status] ?? `Failed to load file (${status}).`);
          return;
        }
        setContent((body as FileContentResponse).content);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey]);

  return { content, error };
}

/**
 * A stored attachment as an object URL.
 *
 * Attachments used to be a plain `<img src>` against the bridge's HTTP route.
 * They now arrive as base64 on the socket, so each one is turned into a blob URL
 * here and revoked when the component unmounts (or the attachment changes) —
 * without that, every re-render would leak a blob for the life of the page.
 */
export function useAttachmentUrl(rel: string | undefined): { url: string | null; error: string | null } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rel) return;
    let revoked: string | null = null;
    let cancelled = false;
    fileRequest('attachment', { rel })
      .then(({ status, body }) => {
        if (cancelled) return;
        if (status !== 200) {
          setError(ERROR_MESSAGES[status] ?? `Failed to load attachment (${status}).`);
          return;
        }
        const { data, mediaType } = body as AttachmentBody;
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        revoked = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
        setUrl(revoked);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [rel]);

  return { url, error };
}
