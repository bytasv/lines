import { useCallback, useEffect, useState } from 'react';
import type {
  DocsResponse,
  FileContentResponse,
  FindResponse,
  TreeEntry,
  TreeResponse,
} from '@lines/shared';
import { withAuthToken } from '../ws';

/** The bridge HTTP server (same host, port 8787) serves file contents and directory listings. */
export const fileBase = `${location.protocol}//${location.hostname}:8787`;

const ERROR_MESSAGES: Record<number, string> = {
  403: 'Access denied — file is outside the project.',
  404: 'File not found.',
  413: 'File too large to preview.',
  415: 'Binary files cannot be previewed.',
};

export async function fetchTree(dir: string): Promise<TreeEntry[]> {
  const res = await fetch(withAuthToken(`${fileBase}/tree?path=${encodeURIComponent(dir)}`));
  if (!res.ok) throw new Error(`Failed to list directory (${res.status}).`);
  const data = (await res.json()) as TreeResponse;
  return data.entries;
}

/** Ranked file-name matches for `query` across every project root, each hit relative to its own root. */
export async function searchFiles(
  roots: string[],
  query: string,
  limit: number,
): Promise<{ root: string; rel: string }[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  // Repeated `path` params, one per root — the bridge 403s if any fails to resolve.
  for (const r of roots) params.append('path', r);
  const res = await fetch(withAuthToken(`${fileBase}/find?${params}`));
  if (!res.ok) throw new Error(`Failed to search files (${res.status}).`);
  const data = (await res.json()) as FindResponse;
  return data.files;
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
  const res = await fetch(withAuthToken(`${fileBase}/docs?path=${encodeURIComponent(docsRoot)}`));
  if (!res.ok) {
    throw new Error(DOCS_ERROR_MESSAGES[res.status] ?? `Failed to load documentation (${res.status}).`);
  }
  return (await res.json()) as DocsResponse;
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
    fetch(withAuthToken(`${fileBase}/file?path=${encodeURIComponent(path)}`))
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(ERROR_MESSAGES[res.status] ?? `Failed to load file (${res.status}).`);
          return;
        }
        const data = (await res.json()) as FileContentResponse;
        if (!cancelled) setContent(data.content);
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
