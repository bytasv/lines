import os from 'node:os';
import path from 'node:path';
import { projectRoots } from '@lines/shared';
import { isPlanPath } from './autoGuard.ts';
import type { UserContext } from './userContext.ts';

/** Every directory this user may read over HTTP: all roots of every open project, plus session cwds. */
export function workspaceRoots(ctx: UserContext): string[] {
  return [
    ...ctx.store.loadProjects().flatMap(projectRoots),
    ...ctx.sessions.list().map((s) => s.cwd),
  ];
}

/**
 * Resolve one path value to an absolute path, or null if outside the user's
 * project/session roots. Plan directories are the one exception: plans live in
 * `~/.claude/plans` (outside every root) and the plan review card re-reads them
 * live. `isPlanPath` anchors containment to real directories, so a traversal out
 * of a plans directory still resolves to null.
 *
 * Lives outside index.ts only so it is importable by its test — index.ts starts
 * listening on import.
 */
export function resolveWorkspacePath(ctx: UserContext, raw: string): string | null {
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  const abs = path.resolve(expanded);
  const allowed =
    workspaceRoots(ctx).some((root) => abs === root || abs.startsWith(root + path.sep)) ||
    isPlanPath(abs, ctx.sessions.list().map((s) => s.cwd));
  return allowed ? abs : null;
}

/** Resolve the single `?path=` query param the file and tree endpoints take. */
export function resolveWorkspaceParam(ctx: UserContext, url: string): string | null {
  return resolveWorkspacePath(ctx, new URL(url, 'http://localhost').searchParams.get('path') ?? '');
}
