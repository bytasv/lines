import os from 'node:os';
import path from 'node:path';
import { projectRoots, type SocketAccess } from '@lines/shared';
import { isPlanPath } from './autoGuard.ts';
import type { UserContext } from './userContext.ts';

/** Every directory this user may read over HTTP: all roots of every open project, plus session cwds. */
export function workspaceRoots(ctx: UserContext, access?: SocketAccess): string[] {
  // A guest reads inside the sessions they were given, and nothing else. The
  // host's project list is deliberately excluded even for a machine-scope guest:
  // a project can span roots that no session of theirs is running in, and "you
  // can use my machine" is not "you can read every repo I have open".
  if (access && access.scope !== 'owner') {
    const sessions = ctx.sessions.list();
    const granted =
      access.scope === 'session'
        ? sessions.filter((s) => access.sessionIds?.includes(s.id))
        : sessions;
    return granted.map((s) => s.cwd);
  }
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
export function resolveWorkspacePath(
  ctx: UserContext,
  raw: string,
  access?: SocketAccess,
): string | null {
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  const abs = path.resolve(expanded);
  const guest = !!access && access.scope !== 'owner';
  const allowed =
    workspaceRoots(ctx, access).some((root) => abs === root || abs.startsWith(root + path.sep)) ||
    // The plans exception is owner-only. `~/.claude/plans` sits outside every
    // project root and holds the host's plans for work a guest has nothing to do
    // with — as an exception it crossed OS users already, and extending it across
    // *people* is a different thing entirely.
    (!guest && isPlanPath(abs, ctx.sessions.list().map((s) => s.cwd)));
  return allowed ? abs : null;
}

/** Resolve the single `?path=` query param the file and tree endpoints take. */
export function resolveWorkspaceParam(ctx: UserContext, url: string): string | null {
  return resolveWorkspacePath(ctx, new URL(url, 'http://localhost').searchParams.get('path') ?? '');
}
