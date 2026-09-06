/**
 * Throwaway spike: does the Claude CLI actually consume a user message pushed
 * into a streaming-input query *while a turn is running*, and does it do so
 * inside that turn rather than as a new one?
 *
 * The SDK declares `SDKUserMessage.priority?: 'now' | 'next' | 'later'` and
 * documents it nowhere, so the semantics have to be measured against the
 * installed CLI before any product code depends on them.
 *
 * Run:  npx tsx server/scripts/spike-interject.ts [arm]
 *       arm = a | b | c | d | all   (default: all)
 *
 * Deliberately standalone — no bridge imports beyond CLI discovery, no MCP, no
 * hooks — so a surprising result is the CLI's, not ours. Delete this file once
 * docs/codebase/features/turn-interjection.md carries the results table.
 *
 * What the arms are:
 *   A  plain push, no `priority`      (exactly what a second `case 'push'` does today)
 *   B  `priority: 'now'`
 *   C  `priority: 'next'`
 *   D  the shipped priority while `canUseTool` is parked on a 20s promise
 *      (does the CLI drain stdin at a permission gate? decides whether
 *      `waiting-permission` is ever send-now-able). Only meaningful when the
 *      VERDICT line reports `gateParked: true`.
 *
 * Results on CLI 2.1.260, 3 runs per arm:
 *   A  1 result, steered inside the turn
 *   B  2 results — the CLI ends the running turn at the next safe point (right
 *      after the pending tool_result) and starts a fresh one. This is what
 *      produced `[ede_diagnostic] result_type=user` in the live app.
 *   C  1 result, steered inside the turn  ← shipped
 *   D  inconclusive on the first pass: ambient ~/.claude settings auto-approved
 *      the Bash so the gate never held. `settingSources: []` below fixes that.
 *   The model reads the message on its next inference, i.e. after the tool call
 *   that was already in flight returns (~1.2s later in these runs). No echo of
 *   the pushed message ever comes back on the stream.
 *
 * What to read off the log:
 *   1. Number of `result` messages before the queue closes. 1 = one turn.
 *      2 = the CLI ran the interjection as its own turn → the feature is dead.
 *   2. Timestamp of the first assistant text containing INTERJECTION-RECEIVED
 *      relative to the first `result`. Before it = real steering.
 *   3. Which boundary it lands on (next tool_result vs next assistant message).
 *      That number becomes the Send now tooltip copy.
 *   4. Whether a `type: 'user'` replay echo comes back on the stream (it would
 *      be persisted by handleSdkMessage).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeCliStatus } from '../src/claudeCli.ts';

/** Copied from worker.ts:41-70 rather than imported: the spike must not drag in
 *  the worker's module graph, and the class is 30 lines. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private resolvers: ((v: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T) {
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value: item, done: false });
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift()!, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

const TURN_1 =
  'Run `sleep 3` via Bash ten times, one at a time, printing the count after each. Do not stop early.';
const INTERJECTION = 'Ignore the counting. Reply with exactly INTERJECTION-RECEIVED and stop.';

type Arm = 'a' | 'b' | 'c' | 'd';

function userMessage(text: string, priority?: 'now' | 'next' | 'later'): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  } as unknown as SDKUserMessage;
}

/** Flatten whatever text a message carries, so INTERJECTION-RECEIVED is findable
 *  wherever the CLI decides to put it. */
function textOf(msg: Record<string, unknown>): string {
  const content = (msg.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return typeof msg.result === 'string' ? msg.result : '';
  return content
    .map((b) => {
      const block = b as { type?: string; text?: string; content?: unknown };
      if (block.type === 'text') return block.text ?? '';
      if (block.type === 'tool_result') return JSON.stringify(block.content).slice(0, 120);
      return `<${block.type}>`;
    })
    .join(' ');
}

async function runArm(arm: Arm) {
  const cli = claudeCliStatus();
  if (!cli.path) throw new Error('no Claude CLI found on this machine');
  const cwd = mkdtempSync(join(tmpdir(), `lines-spike-${arm}-`));
  const queue = new AsyncQueue<SDKUserMessage>();
  const t0 = Date.now();
  const log = (row: Record<string, unknown>) =>
    console.log(JSON.stringify({ arm, ms: Date.now() - t0, ...row }));

  log({ note: 'start', cli: cli.path, version: cli.version, cwd });

  const q = query({
    prompt: queue as AsyncIterable<SDKUserMessage>,
    options: {
      cwd,
      pathToClaudeCodeExecutable: cli.path,
      permissionMode: 'bypassPermissions',
      // No ambient config. Without this the runner's own ~/.claude settings load:
      // its hooks fire (visible as hook_started/hook_response in the log) and its
      // Bash allowlist auto-approves the spike's `sleep`, which silently turned
      // arm D into a second copy of arm B on the first run.
      settingSources: [],
      // Arm D parks the CLI inside a permission gate for 20s and pushes into it.
      // Everything else runs with no canUseTool at all.
      ...(arm === 'd'
        ? {
            permissionMode: 'default' as const,
            canUseTool: async (toolName: string, input: Record<string, unknown>) => {
              gateParked = true;
              log({ note: 'canUseTool parked', toolName });
              await new Promise((r) => setTimeout(r, 20_000));
              log({ note: 'canUseTool released', toolName });
              return { behavior: 'allow' as const, updatedInput: input };
            },
          }
        : {}),
    } as never,
  });

  queue.push(userMessage(TURN_1));

  const pushAt = setTimeout(() => {
    // Arm D carries the *shipped* priority, so it measures the permission gate
    // rather than re-measuring 'now' (which arm B already settled).
    const priority = arm === 'b' ? 'now' : arm === 'c' || arm === 'd' ? 'next' : undefined;
    log({ note: 'pushing interjection', priority: priority ?? '(none)' });
    queue.push(userMessage(INTERJECTION, priority));
  }, 6_000);

  let results = 0;
  let gateParked = false;
  let firstResultMs: number | null = null;
  let interjectionSeenMs: number | null = null;
  let userEcho = 0;

  try {
    for await (const message of q) {
      const msg = message as Record<string, unknown> & { type: string };
      const text = textOf(msg);
      log({
        type: msg.type,
        subtype: msg.subtype,
        uuid: msg.uuid,
        parent_tool_use_id: msg.parent_tool_use_id,
        text: text.length > 200 ? `${text.slice(0, 200)}…` : text,
      });
      if (msg.type === 'user') userEcho++;
      if (text.includes('INTERJECTION-RECEIVED') && interjectionSeenMs === null) {
        interjectionSeenMs = Date.now() - t0;
      }
      if (msg.type === 'result') {
        results++;
        firstResultMs ??= Date.now() - t0;
        // Give the CLI a beat to start a *second* turn if it decided to treat the
        // interjection as one — that is observable 1, the go/no-go.
        setTimeout(() => queue.close(), 4_000);
      }
    }
  } finally {
    clearTimeout(pushAt);
    queue.close();
  }

  const verdict = {
    arm,
    cliVersion: cli.version,
    results,
    firstResultMs,
    interjectionSeenMs,
    userEchoMessages: userEcho,
    // Arm D is only meaningful if the gate actually held the CLI. False here means
    // the run answered nothing about `waiting-permission` — do not read it as a no.
    ...(arm === 'd' ? { gateParked } : {}),
    steeredInsideTurn:
      results === 1 && interjectionSeenMs !== null && firstResultMs !== null
        ? interjectionSeenMs < firstResultMs
        : false,
  };
  console.log(`VERDICT ${JSON.stringify(verdict)}`);
  return verdict;
}

const requested = (process.argv[2] ?? 'all').toLowerCase();
const arms: Arm[] = requested === 'all' ? ['a', 'b', 'c', 'd'] : [requested as Arm];
const verdicts = [];
for (const arm of arms) {
  // Three runs per arm: one run cannot tell a real boundary from a scheduling
  // fluke, and this is the only evidence the design rests on.
  for (let run = 0; run < 3; run++) verdicts.push(await runArm(arm));
}
console.log(`SUMMARY ${JSON.stringify(verdicts, null, 2)}`);
