import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DeviceHub } from './mux.ts';
import type { Sink } from './mux.ts';

/**
 * The relay terminates TLS, so prompts, file contents and transcripts pass
 * through it in the clear. "We don't log payloads" is a promise; these tests are
 * what make it a property.
 *
 * They are also why `payload` is an opaque string in the protocol: if nothing
 * here parses it, nothing here can accidentally print it.
 */

/** Something no innocent log line would ever contain. */
const CANARY = 'CANARY-8f3a-prompt-body-do-not-log';

function captureConsole(t: { after: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const record =
    (fn: (...a: unknown[]) => void) =>
    (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      void fn;
    };
  console.log = record(originals.log);
  console.warn = record(originals.warn);
  console.error = record(originals.error);
  console.info = record(originals.info);
  t.after(() => Object.assign(console, originals));
  return lines;
}

function fakeSink(): { sink: Sink; sent: string[] } {
  const sent: string[] = [];
  return { sink: { send: (d) => sent.push(d), close: () => {} }, sent };
}

test('routing a payload in either direction logs nothing containing it', (t) => {
  const lines = captureConsole(t);
  const hub = new DeviceHub('d1');
  const agent = fakeSink();
  hub.attachAgent(agent.sink);
  const client = fakeSink();
  const ch = hub.openChannel('u1', 'ctrl', client.sink, `token-${CANARY}`);

  hub.fromClient(ch, JSON.stringify({ type: 'prompt', text: CANARY }));
  hub.fromAgent({ t: 'data', ch, payload: JSON.stringify({ type: 'event', data: CANARY }) }, agent.sink);
  hub.setToken('u1', `token-${CANARY}`);
  hub.closeChannel(ch);

  const leaked = lines.filter((l) => l.includes(CANARY));
  assert.deepEqual(leaked, [], `payload or token reached a log sink: ${leaked.join(' | ')}`);
});

test('the payload still arrives intact — redaction is not silent dropping', (t) => {
  captureConsole(t);
  const hub = new DeviceHub('d1');
  const agent = fakeSink();
  hub.attachAgent(agent.sink);
  const client = fakeSink();
  const ch = hub.openChannel('u1', 'ctrl', client.sink, null);

  hub.fromAgent({ t: 'data', ch, payload: CANARY }, agent.sink);
  assert.ok(client.sent.includes(CANARY), 'the browser must still receive the payload verbatim');
});

test('no source file logs a payload or secret field', () => {
  // A static check as well as the runtime one: a new console.log on a path this
  // suite does not exercise would otherwise slip through.
  const dir = import.meta.dirname;
  const offenders: string[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (!/console\.(log|warn|error|info)/.test(line)) return;
      // Naming any of these in a log argument means interpolating a secret.
      if (/\b(payload|secret|token)\b/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `log statement(s) referencing a payload or secret:\n${offenders.join('\n')}`);
});
