import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage, SessionMeta, UserUiSettings } from '@lines/shared';
import type { AuthManager } from './auth.ts';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import type { WorkerClient } from './workerClient.ts';

/**
 * The packaged app ships no `claude`, so which binary a turn runs — and what
 * happens when there is none — is product behaviour, not an implementation
 * detail. Both halves are asserted through a real push.
 *
 * `LINES_CLAUDE_PATH` is exclusive (see claudeCli.ts), which is what lets this
 * file force "no CLI" on a machine that has one. node:test gives each file its
 * own process, so the env and the module-level cache stay local to it.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-cli-session-'));
const FAKE_CLI = path.join(TMP, 'claude');
fs.writeFileSync(FAKE_CLI, '#!/bin/sh\necho "2.1.224 (Claude Code)"\n', { mode: 0o755 });

const meta = (id: string): SessionMeta =>
  ({
    id,
    name: id,
    cwd: '/tmp',
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    status: 'idle',
    createdAt: 1,
  }) as SessionMeta;

/** Same shape as sessions.spawn.test.ts: a manager over a throwaway store. */
function harness(settings?: UserUiSettings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-cli-store-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta('s1')]));
  const store = createStore(root);
  if (settings) store.saveSettings(settings);
  const auth = {
    getAccessTokenSync: () => 'tok',
    ensureFreshToken: async () => 'tok',
    handleTokenRejected: async () => ({ outcome: 'refreshed' }),
  } as unknown as AuthManager;
  const broadcasts: ServerMessage[] = [];
  const sessions = new SessionManager(store, new GuardAllowlist(store), (msg) => broadcasts.push(msg), auth);
  const pushes: Record<string, unknown>[] = [];
  sessions.attachWorker({
    push: (_sessionId: string, _message: unknown, options: Record<string, unknown>) => pushes.push(options),
    close: () => {},
  } as unknown as WorkerClient);
  return { sessions, pushes, store };
}

/** A fake `claude` that reports `version`, so the Code Mode floor is testable. */
function fakeCli(version: string): string {
  const bin = path.join(fs.mkdtempSync(path.join(TMP, 'v-')), 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
  return bin;
}

const envOf = (options: Record<string, unknown>) => options.env as Record<string, string> | undefined;

/** Let the fire-and-forget pushTurn chain settle (no timers involved). */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Import fresh so the module-level cache is rebuilt against the current env. */
async function refresh() {
  const { refreshClaudeCli } = await import('./claudeCli.ts');
  return refreshClaudeCli();
}

test('every spawn names the CLI this machine resolved', async () => {
  process.env.LINES_CLAUDE_PATH = FAKE_CLI;
  await refresh();
  const h = harness();

  h.sessions.prompt('s1', 'hello');
  await settle();

  assert.equal(h.pushes.length, 1);
  // Serialized to the worker, which spreads it into its own query() — so this
  // one option is what makes the packaged app use the machine's install.
  assert.equal(h.pushes[0]!.pathToClaudeCodeExecutable, FAKE_CLI);
});

test('a turn is refused with install instructions when there is no CLI', async () => {
  process.env.LINES_CLAUDE_PATH = path.join(TMP, 'not-installed');
  const status = await refresh();
  assert.equal(status.state, 'missing');
  const h = harness();

  h.sessions.prompt('s1', 'hello');
  await settle();

  assert.deepEqual(h.pushes, [], 'the SDK must not be asked to find a binary itself');
  const message = String(h.sessions.get('s1')?.errorMessage);
  assert.match(message, /Claude Code not found on this machine/);
  assert.match(message, /docs\.claude\.com/);
  assert.equal(h.sessions.get('s1')?.status, 'error');
});

test('Code Mode on with a new enough CLI adds the flag beside the OAuth token', async () => {
  process.env.LINES_CLAUDE_PATH = fakeCli('2.1.323');
  await refresh();
  const h = harness({ claudeCodeMode: true });

  h.sessions.prompt('s1', 'hello');
  await settle();

  const env = envOf(h.pushes[0]!);
  assert.equal(env?.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE, '1');
  assert.equal(env?.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
});

test('Code Mode off or unset never sends the flag', async () => {
  process.env.LINES_CLAUDE_PATH = fakeCli('2.1.325');
  await refresh();
  for (const settings of [undefined, { claudeCodeMode: false }] as const) {
    const h = harness(settings);
    h.sessions.prompt('s1', 'hello');
    await settle();
    const env = envOf(h.pushes[0]!);
    // Only what the bridge itself sets is asserted: an ambient var the bridge
    // was started with is inherited through process.env, not added here.
    if (!process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE) {
      assert.equal(env?.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE, undefined);
    }
    assert.equal(env?.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
  }
});

test('Code Mode is skipped on a CLI older than its floor, and the turn still runs', async () => {
  process.env.LINES_CLAUDE_PATH = fakeCli('2.1.322');
  await refresh();
  const h = harness({ claudeCodeMode: true });

  h.sessions.prompt('s1', 'hello');
  await settle();

  assert.equal(h.pushes.length, 1);
  const env = envOf(h.pushes[0]!);
  if (!process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE) {
    assert.equal(env?.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE, undefined);
  }
  assert.equal(env?.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
});

test('a Code Mode toggle reaches the next turn without touching the session', async () => {
  process.env.LINES_CLAUDE_PATH = fakeCli('2.1.325');
  await refresh();
  const h = harness({ claudeCodeMode: false });

  h.sessions.prompt('s1', 'hello');
  await settle();
  h.store.saveSettings({ claudeCodeMode: true });
  h.sessions.prompt('s1', 'again');
  await settle();

  assert.equal(envOf(h.pushes[1]!)?.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE, '1');
});
