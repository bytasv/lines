import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SessionMeta } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { resolveReasoningEffort, SessionManager } from './sessions.ts';
import { createStore } from './store.ts';

/**
 * Manual reasoning effort on the Claude path.
 *
 * Two properties matter here and neither is visible from the UI: the option key
 * is *absent* when the user has chosen nothing (so an untouched session's options
 * stay what they always were), and changing the effort actually drops the live
 * query — the worker reuses a query and discards the options of every later push,
 * so without that the feature looks applied and does nothing.
 *
 * No AuthManager is wired, which is what keeps the push path synchronous (see
 * pushTurn) and off the Claude CLI check.
 */
const meta = (id: string): SessionMeta =>
  ({
    id,
    name: id,
    cwd: '/tmp',
    model: 'claude-opus-5',
    permissionMode: 'default',
    status: 'idle',
    createdAt: 1,
  }) as SessionMeta;

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-effort-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta('s1')]));
  const store = createStore(root);
  const sessions = new SessionManager(store, new GuardAllowlist(store), () => {});
  const closes: string[] = [];
  const pushes: Record<string, unknown>[] = [];
  sessions.attachWorker({
    push: (_sessionId: string, _message: unknown, options: Record<string, unknown>) =>
      pushes.push(options),
    close: (sessionId: string) => closes.push(sessionId),
    interrupt: () => {},
    setModel: () => {},
    setPermissionMode: () => {},
  } as never);
  return { sessions, store, closes, pushes };
}

/** Let the fire-and-forget push chain settle (no timers involved). */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

test('the session’s own effort is what an ordinary turn resolves to', () => {
  assert.equal(
    resolveReasoningEffort({ permissionMode: 'default', reasoningEffort: 'high' }, null, CLAUDE_EFFORTS),
    'high',
  );
});

test('plan mode prefers the global plan effort over the session’s', () => {
  assert.equal(
    resolveReasoningEffort(
      { permissionMode: 'plan', reasoningEffort: 'low' },
      { planReasoningEffort: 'xhigh' },
      CLAUDE_EFFORTS,
    ),
    'xhigh',
  );
  // The global one is plan-mode only: an ordinary turn in the same session is
  // unaffected by it.
  assert.equal(
    resolveReasoningEffort(
      { permissionMode: 'default', reasoningEffort: 'low' },
      { planReasoningEffort: 'xhigh' },
      CLAUDE_EFFORTS,
    ),
    'low',
  );
});

test('plan mode with no plan effort set falls back to the session’s own', () => {
  assert.equal(
    resolveReasoningEffort({ permissionMode: 'plan', reasoningEffort: 'medium' }, {}, CLAUDE_EFFORTS),
    'medium',
  );
});

test('nothing chosen resolves to undefined, i.e. the provider’s default', () => {
  assert.equal(resolveReasoningEffort({ permissionMode: 'default' }, {}, CLAUDE_EFFORTS), undefined);
});

test('a level this provider does not offer is dropped rather than sent', () => {
  // The two vocabularies agree today, so this is guarding the *next* divergence:
  // a stored level an engine stops accepting has to become "the default", never a
  // value the API rejects. Measured precedent — codex answers a level it does not
  // know with a 400 that fails the whole turn.
  const narrow = ['low', 'medium'] as const;
  assert.equal(
    resolveReasoningEffort({ permissionMode: 'default', reasoningEffort: 'max' }, {}, narrow),
    undefined,
  );
  // Including one that only arrives through the global plan-mode setting.
  assert.equal(
    resolveReasoningEffort({ permissionMode: 'plan' }, { planReasoningEffort: 'xhigh' }, narrow),
    undefined,
  );
});

test('a Claude push carries no effort key at all until one is chosen', async () => {
  const h = harness();
  h.sessions.prompt('s1', 'go');
  await settle();

  assert.equal(h.pushes.length, 1);
  // `in`, not a value check: the regression guarded against is a null or an empty
  // string reaching the SDK, which is not the same as the key being absent.
  assert.equal('effort' in h.pushes[0]!, false);
});

test('a chosen effort reaches the Claude query options', async () => {
  const h = harness();
  h.sessions.setReasoningEffort('s1', 'xhigh');
  h.sessions.prompt('s1', 'go');
  await settle();

  assert.equal(h.pushes[0]!.effort, 'xhigh');
});

/**
 * Closes counted from the first push onwards, never in absolute terms: the very
 * first push of a session always recycles (the token it was spawned with is
 * unknown until then), so only what happens *after* that says anything.
 */
async function firstTurn(h: ReturnType<typeof harness>) {
  h.sessions.prompt('s1', 'first');
  await settle();
  h.sessions.setStatus('s1', 'idle');
  return h.closes.length;
}

test('changing the effort drops the live query so the next turn rebuilds it', async () => {
  const h = harness();
  const baseline = await firstTurn(h);
  // The query is live now, and `ensureSession` in the worker would return it
  // early and throw the next push's options away.

  h.sessions.setReasoningEffort('s1', 'high');
  // Not closed on the spot: a busy session must finish its turn, and a session
  // holding background tasks must keep them.
  assert.equal(h.closes.length, baseline);

  h.sessions.prompt('s1', 'second');
  await settle();

  assert.equal(h.closes.length, baseline + 1);
  assert.equal(h.pushes.at(-1)!.effort, 'high');
});

test('a turn that changed nothing keeps its query', async () => {
  const h = harness();
  const baseline = await firstTurn(h);

  h.sessions.prompt('s1', 'second');
  await settle();

  assert.equal(h.closes.length, baseline);
  assert.equal(h.pushes.length, 2);
});

test('clearing the effort back to Auto also rebuilds the query', async () => {
  const h = harness();
  h.sessions.setReasoningEffort('s1', 'high');
  const baseline = await firstTurn(h);

  h.sessions.setReasoningEffort('s1', null);
  h.sessions.prompt('s1', 'second');
  await settle();

  assert.equal(h.closes.length, baseline + 1);
  assert.equal('effort' in h.pushes.at(-1)!, false);
});

test('entering plan mode rebuilds the query when a plan effort is set', async () => {
  const h = harness();
  h.store.saveSettings({ planReasoningEffort: 'max' });
  const baseline = await firstTurn(h);

  h.sessions.setPermissionMode('s1', 'plan');
  h.sessions.prompt('s1', 'second');
  await settle();

  assert.equal(h.closes.length, baseline + 1);
  assert.equal(h.pushes.at(-1)!.effort, 'max');
});
