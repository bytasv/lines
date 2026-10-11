/**
 * Throwaway spike: when does each engine *report* that a message steered into a
 * running turn has actually been taken in by the model?
 *
 * Lines renders a steered message in the transcript the moment it is sent. Both
 * native apps instead show it where the model picked it up — mid-story, after
 * the part already written. To do the same, the bridge needs a signal at that
 * moment. Candidates:
 *
 *   claude  the stream-json replay ack (`--replay-user-messages`): the CLI echoes
 *           a user message read from stdin back as `{ type: 'user', isReplay }`.
 *           Unknown: does it fire on stdin receipt or when the message enters
 *           the model's context?
 *   codex   `item/started` / `item/completed` with `item.type === 'userMessage'`
 *           after `turn/steer`. Unknown: when, relative to the agent's output.
 *
 * Two scenarios per engine:
 *   tool  the turn runs `sleep 3` several times; the push lands mid-tool
 *   text  the turn writes a long story with no tools; the push lands mid-text
 *
 * Run:  npx tsx server/scripts/spike-interject-ack.ts <claude|codex> [tool|text|all] [runs]
 *
 * Results, 2026-10-10, Claude CLI 2.1.288 / codex-cli 0.156.1, 2 runs per arm:
 *   claude tool  ack 4.2–4.9s after the push, right after the in-flight
 *                tool_result and just before the next model request; 1 result
 *   claude text  no pickup mid-story: the story finished, its `result` landed,
 *                then the ack arrived and the CLI ran the message as a SECOND
 *                turn (2 results)
 *   codex  tool  `item/started` userMessage 0.9–4.4s after the push, at the
 *                next step; 1 turn
 *   codex  text  also no pickup mid-story: the ack came only after the whole
 *                story (~17k chars, ~2 min), but inside the same turn (1 turn)
 *   Both acks mark the real pickup point: the agent's next output was the
 *   21-character marker reply. (`reactMs` stays null for codex because the
 *   marker arrives split across deltas; `textAfterAckChars` = 21 is the reply.)
 *
 * What to read off the log (one JSON row per event, `ms` since start):
 *   pushMs     when the steer left this process
 *   ackMs      when the engine's ack arrived (claude replay / codex userMessage item)
 *   reactMs    first agent output that obeys the interjection (INTERJECTION-RECEIVED)
 *   results    turns completed — 2 means the message opened a turn of its own
 *   textAfterAckChars  agent text streamed between ack and reaction: ~0 means
 *              the ack marks the real pickup point; large means it fires early
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeCliStatus } from '../src/claudeCli.ts';
import { codexCliStatus } from '../src/codexCli.ts';
import { CodexAppServer } from '../src/codexAppServer.ts';

type Scenario = 'tool' | 'text';

const PROMPTS: Record<Scenario, string> = {
  tool: 'Run `sleep 3` via the shell five times, one at a time, saying the count after each. Do not stop early.',
  text: 'Write a long, detailed story (at least 1200 words) about a lighthouse keeper. Do not use any tools.',
};
const INTERJECTION = 'Stop what you are doing. Reply with exactly INTERJECTION-RECEIVED and nothing else.';
const MARKER = 'INTERJECTION-RECEIVED';

interface Verdict {
  engine: string;
  scenario: Scenario;
  pushMs: number | null;
  ackMs: number | null;
  reactMs: number | null;
  results: number;
  textBeforeAckChars: number;
  textAfterAckChars: number;
  ackKinds: string[];
}

function newVerdict(engine: string, scenario: Scenario): Verdict {
  return {
    engine,
    scenario,
    pushMs: null,
    ackMs: null,
    reactMs: null,
    results: 0,
    textBeforeAckChars: 0,
    textAfterAckChars: 0,
    ackKinds: [],
  };
}

/** Copied from worker.ts rather than imported, as spike-interject.ts does. */
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
    for (const resolve of this.resolvers.splice(0)) resolve({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

function userMessage(text: string, priority?: 'next'): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  } as unknown as SDKUserMessage;
}

async function runClaude(scenario: Scenario): Promise<Verdict> {
  const cli = claudeCliStatus();
  if (!cli.path) throw new Error('no Claude CLI found');
  const v = newVerdict('claude', scenario);
  const queue = new AsyncQueue<SDKUserMessage>();
  const t0 = Date.now();
  const log = (row: Record<string, unknown>) =>
    console.log(JSON.stringify({ engine: 'claude', scenario, ms: Date.now() - t0, ...row }));
  log({ note: 'start', version: cli.version });

  const q = query({
    prompt: queue as AsyncIterable<SDKUserMessage>,
    options: {
      cwd: mkdtempSync(join(tmpdir(), `lines-ack-claude-${scenario}-`)),
      pathToClaudeCodeExecutable: cli.path,
      permissionMode: 'bypassPermissions',
      settingSources: [],
      includePartialMessages: true,
      // The candidate signal. Not something the worker passes today.
      extraArgs: { 'replay-user-messages': null },
    } as never,
  });

  queue.push(userMessage(PROMPTS[scenario]));
  let pushTimer: NodeJS.Timeout | undefined;
  const schedulePush = (delay: number) => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      v.pushMs = Date.now() - t0;
      log({ note: 'PUSH' });
      queue.push(userMessage(INTERJECTION, 'next'));
    }, delay);
  };
  // Tool: a fixed delay lands inside the sleeps. Text: wait for the story to start.
  if (scenario === 'tool') schedulePush(8_000);

  let replays = 0;
  try {
    for await (const message of q) {
      const msg = message as Record<string, unknown> & { type: string };
      if (msg.type === 'stream_event') {
        const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } };
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          const text = ev.delta.text ?? '';
          if (scenario === 'text') schedulePush(4_000);
          if (v.pushMs !== null) {
            if (v.ackMs === null) v.textBeforeAckChars += text.length;
            else if (v.reactMs === null) v.textAfterAckChars += text.length;
          }
          if (text.includes(MARKER.slice(0, 8)) && v.reactMs === null) {
            v.reactMs = Date.now() - t0;
            log({ note: 'REACT' });
          }
        } else if (ev.type === 'message_start' || ev.type === 'message_stop') {
          log({ stream: ev.type });
        }
        continue;
      }
      if (msg.type === 'user') {
        const isReplay = msg.isReplay === true;
        const content = (msg.message as { content?: unknown })?.content;
        const isInterjection = JSON.stringify(content ?? '').includes('INTERJECTION-RECEIVED and nothing');
        log({ type: 'user', isReplay, isInterjection, tool: JSON.stringify(content ?? '').includes('tool_result') });
        if (isReplay) replays++;
        if (isReplay && isInterjection && v.ackMs === null) {
          v.ackMs = Date.now() - t0;
          v.ackKinds.push('replay');
          log({ note: 'ACK' });
        }
        continue;
      }
      if (msg.type === 'assistant') {
        const blocks = ((msg.message as { content?: { type: string; text?: string; name?: string }[] })?.content ?? []);
        const text = blocks.map((b) => (b.type === 'text' ? b.text : `<${b.name ?? b.type}>`)).join(' ');
        if (text.includes(MARKER) && v.reactMs === null) v.reactMs = Date.now() - t0;
        log({ type: 'assistant', text: text.slice(0, 120) });
        continue;
      }
      if (msg.type === 'result') {
        v.results++;
        log({ type: 'result', subtype: msg.subtype });
        setTimeout(() => queue.close(), 6_000);
        continue;
      }
      log({ type: msg.type, subtype: msg.subtype });
    }
  } finally {
    if (pushTimer) clearTimeout(pushTimer);
    queue.close();
  }
  log({ note: 'done', replays });
  return v;
}

async function runCodex(scenario: Scenario): Promise<Verdict> {
  const cli = codexCliStatus();
  if (!cli.path) throw new Error('no codex CLI found');
  const codexHome = process.env.SPIKE_CODEX_HOME;
  if (!codexHome) throw new Error('set SPIKE_CODEX_HOME to a logged-in CODEX_HOME');
  const v = newVerdict('codex', scenario);
  const t0 = Date.now();
  const log = (row: Record<string, unknown>) =>
    console.log(JSON.stringify({ engine: 'codex', scenario, ms: Date.now() - t0, ...row }));
  log({ note: 'start', version: cli.version });

  let threadId = '';
  let turnId: string | undefined;
  let pushTimer: NodeJS.Timeout | undefined;
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));

  const steer = () => {
    if (!turnId) return log({ note: 'no live turn to steer' });
    v.pushMs = Date.now() - t0;
    log({ note: 'PUSH' });
    app
      .request('turn/steer', {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: 'text', text: INTERJECTION, text_elements: [] }],
      })
      .then((r) => log({ note: 'steer answered', result: r }))
      .catch((e) => log({ note: 'steer failed', error: String(e) }));
  };
  const schedulePush = (delay: number) => {
    if (!pushTimer) pushTimer = setTimeout(steer, delay);
  };

  const app: CodexAppServer = new CodexAppServer({
    codexPath: cli.path,
    codexHome,
    onNotification: (method, params) => {
      const item = params.item as { type?: string; content?: unknown; command?: string } | undefined;
      if (method === 'turn/started') {
        turnId = (params.turn as { id?: string })?.id;
        log({ method, turnId });
        if (scenario === 'tool') schedulePush(8_000);
        return;
      }
      if (method === 'item/agentMessage/delta') {
        const text = String(params.delta ?? '');
        if (scenario === 'text') schedulePush(4_000);
        if (v.pushMs !== null) {
          if (v.ackMs === null) v.textBeforeAckChars += text.length;
          else if (v.reactMs === null) v.textAfterAckChars += text.length;
        }
        if (text.includes(MARKER.slice(0, 8)) && v.reactMs === null) {
          v.reactMs = Date.now() - t0;
          log({ note: 'REACT' });
        }
        return;
      }
      if (method === 'item/started' || method === 'item/completed') {
        log({ method, itemType: item?.type, command: item?.command });
        const isInterjection =
          item?.type === 'userMessage' && JSON.stringify(item.content ?? '').includes('nothing else');
        if (isInterjection) {
          v.ackKinds.push(method);
          if (v.ackMs === null) {
            v.ackMs = Date.now() - t0;
            log({ note: 'ACK', method });
          }
        }
        return;
      }
      if (method === 'turn/completed') {
        v.results++;
        log({ method });
        turnId = undefined;
        setTimeout(finish, 6_000);
        return;
      }
      if (!method.includes('delta')) log({ method });
    },
    onServerRequest: (id, method) => {
      log({ serverRequest: method });
      // Approvals are off (approvalPolicy never); anything else is unexpected.
      app.respond?.(id, { decision: 'accept' });
    },
    onExit: (reason) => {
      log({ note: 'app-server exit', reason });
      finish();
    },
  } as never);

  const started = (await app.request('thread/start', {
    cwd: mkdtempSync(join(tmpdir(), `lines-ack-codex-${scenario}-`)),
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
  })) as { thread?: { id?: string } };
  threadId = started.thread!.id!;
  await app.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: PROMPTS[scenario], text_elements: [] }],
  });
  await finished;
  if (pushTimer) clearTimeout(pushTimer);
  app.close?.();
  return v;
}

const engine = process.argv[2];
const which = (process.argv[3] ?? 'all') as Scenario | 'all';
const runs = Number(process.argv[4] ?? 2);
const scenarios: Scenario[] = which === 'all' ? ['tool', 'text'] : [which];
const verdicts: Verdict[] = [];
for (const scenario of scenarios) {
  for (let i = 0; i < runs; i++) {
    const v = engine === 'codex' ? await runCodex(scenario) : await runClaude(scenario);
    console.log(`VERDICT ${JSON.stringify(v)}`);
    verdicts.push(v);
  }
}
console.log(`SUMMARY ${JSON.stringify(verdicts)}`);
process.exit(0);
