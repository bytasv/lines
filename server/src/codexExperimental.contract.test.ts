import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { test } from 'node:test';
import { findCodexCli } from './codexCli.ts';

/**
 * Canary for the parts of the app-server protocol that `generate-ts` cannot see.
 *
 * `codexAppServer.contract.test.ts` asserts against the vendored types, which is
 * the right check for everything those types describe. Plan mode is not one of
 * those things: `collaborationMode/list` and `turn/start`'s `collaborationMode`
 * field exist only for a client that declared `experimentalApi`, and
 * `generate-ts` runs without it — verified, the generated output contains neither,
 * with or without `--enable collaboration_modes`. So the types are a filtered view
 * of the API, and trusting them as complete is exactly the mistake that cost this
 * integration a working plan mode.
 *
 * This asks the installed binary instead. It spawns `codex app-server` and calls
 * one read-only method — no model turn, no tokens, no account required beyond
 * what discovery already needs. Skipped when no codex is installed, so a machine
 * without one still runs a green suite.
 */

const HANDSHAKE = {
  clientInfo: { name: 'lines-test', title: 'Lines', version: '0.0.0' },
  capabilities: { experimentalApi: true, requestAttestation: false },
};

/** One request/response against a freshly spawned app-server. */
async function ask(binary: string, method: string, params: unknown): Promise<unknown> {
  const child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const pending = new Map<number, (value: unknown) => void>();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let msg: { id?: number; result?: unknown; error?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id === undefined || (msg.result === undefined && msg.error === undefined)) return;
    pending.get(msg.id)?.(msg.error ?? msg.result);
    pending.delete(msg.id);
  });
  let id = 0;
  const send = (m: string, p: unknown) =>
    new Promise<unknown>((resolve) => {
      const mine = id++;
      pending.set(mine, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method: m, params: p })}\n`);
    });
  try {
    await send('initialize', HANDSHAKE);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    return await send(method, params);
  } finally {
    child.kill();
  }
}

const installed = findCodexCli();

test('codex still offers a Plan collaboration mode to an experimental client', { skip: !installed }, async () => {
  const answer = (await ask(installed!.path, 'collaborationMode/list', {})) as {
    data?: { mode?: string; reasoning_effort?: string | null }[];
  };
  const modes = answer?.data ?? [];
  assert.ok(Array.isArray(answer?.data), `collaborationMode/list answered ${JSON.stringify(answer).slice(0, 200)}`);
  const plan = modes.find((m) => m.mode === 'plan');
  assert.ok(plan, 'codex no longer lists a plan mode — Lines plan mode on OpenAI is broken');
  // Not merely present: the effort is what the worker fills in, and a null there
  // is taken literally by turn/start (a plan turn sent with null asks nothing and
  // emits no plan item). If this stops being a string, applyModePreset's fallback
  // is what keeps plan mode working.
  assert.ok(
    typeof plan!.reasoning_effort === 'string' || plan!.reasoning_effort === null,
    'plan preset carries an unexpected reasoning_effort shape',
  );
  assert.ok(modes.some((m) => m.mode === 'default'), 'codex no longer lists a default mode');
});
