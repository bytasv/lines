import { useEffect, useState } from 'react';
import type { FileContentResponse, FindResponse, TreeEntry, TreeResponse } from '@lines/shared';
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

/** Ranked project-wide file-name matches for `query`, as paths relative to `root`. */
export async function searchFiles(root: string, query: string, limit: number): Promise<string[]> {
  const params = new URLSearchParams({ path: root, q: query, limit: String(limit) });
  const res = await fetch(withAuthToken(`${fileBase}/find?${params}`));
  if (!res.ok) throw new Error(`Failed to search files (${res.status}).`);
  const data = (await res.json()) as FindResponse;
  return data.files;
}

/** Fetch a file's contents from the bridge; returns loading/error/content states. */
export function useFileContent(path: string | undefined) {
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
  }, [path]);

  return { content, error };
}
