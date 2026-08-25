import type { SessionDiffFileResponse, SessionDiffResponse } from '@lines/shared';
import { fileRequest } from '../ws';

/**
 * Reads for the session review diff — "what did this session change?" — over the
 * same WebSocket file-request plumbing as the tree and docs readers. Shaped like
 * `fetchTree`/`fetchDocs` in ./files.ts, including the HTTP-code → message maps.
 */

const DIFF_ERROR_MESSAGES: Record<number, string> = {
  403: 'You do not have access to this session’s changes.',
  404: 'This session is no longer on its machine.',
};

const FILE_ERROR_MESSAGES: Record<number, string> = {
  403: 'Access denied — that file is outside the session’s repository.',
  404: 'File not found in this session’s repository.',
  413: 'File too large to diff.',
  415: 'Binary files cannot be diffed.',
};

function fail(status: number, messages: Record<number, string>, fallback: string): never {
  throw new Error(messages[status] ?? `${fallback} (${status}).`);
}

/** Every changed file, per commit unit. Carries no contents — those load on click. */
export async function fetchSessionDiff(sessionId: string): Promise<SessionDiffResponse> {
  const { status, body } = await fileRequest('sessionDiff', { sessionId });
  if (status !== 200) fail(status, DIFF_ERROR_MESSAGES, 'Failed to load changes');
  return body as SessionDiffResponse;
}

/** One file's baseline and on-disk contents, for the Monaco diff. */
export async function fetchSessionDiffFile(
  sessionId: string,
  repo: string,
  rel: string,
): Promise<SessionDiffFileResponse> {
  const { status, body } = await fileRequest('sessionDiffFile', { sessionId, paths: [repo], rel });
  if (status !== 200) fail(status, FILE_ERROR_MESSAGES, 'Failed to load file');
  return body as SessionDiffFileResponse;
}
