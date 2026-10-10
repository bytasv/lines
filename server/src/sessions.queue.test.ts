import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type {
  Actor,
  Attachment,
  MentionRange,
  QueuedPrompt,
  ServerMessage,
  SessionMeta,
} from '@lines/shared';
import { createStore } from './store.ts';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import type { WorkerClient } from './workerClient.ts';

/**
 * The server-side prompt queue: editing an item in place, and the file cleanup
 * that cancelling one does.
 *
 * The queue is the shared-session approval surface — a guest's prompt lands
 * paused in the owner's queue and runs on the owner's machine, as them — so the
 * cases that matter here are the authority ones: who may rewrite whose prompt,
 * and that an edit is not an approval.
 */

const ALICE: Actor = { userId: 'u-alice', name: 'Alice', imageUrl: null };
const BOB: Actor = { userId: 'u-bob', name: 'Bob', imageUrl: null };
const OWNER: Actor = { userId: 'u-owner', name: 'Owner', imageUrl: null };

const SID = 's1';

const meta = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: SID,
    name: SID,
    cwd: '/tmp',
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    // Busy, so userPrompt takes the queue branch instead of starting a real turn.
    status: 'running',
    createdAt: 1,
    ...over,
  }) as SessionMeta;

/** A manager over a throwaway store, seeded with one session. */
function harness(over: Partial<SessionMeta> = {}, workerOpts: { linkOpen?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-queue-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta(over)]));
  const store = createStore(root);
  const broadcasts: ServerMessage[] = [];
  const sessions = new SessionManager(store, new GuardAllowlist(store), (m) => broadcasts.push(m));
  const pushes: Record<string, unknown>[] = [];
  const closes: string[] = [];
  sessions.attachWorker({
    push: (_sid: string, message: unknown) => pushes.push(message as Record<string, unknown>),
    close: (sid: string) => closes.push(sid),
    interrupt: () => {},
    // The one guard against a push being buffered into a *future* query.
    get linkOpen() {
      return workerOpts.linkOpen ?? true;
    },
  } as unknown as WorkerClient);
  /** Write a real attachment file and return the ref a queued item would hold. */
  const stage = (name: string): Attachment => {
    const file = store.saveAttachment(SID, name, Buffer.from(name).toString('base64'));
    return { name, mediaType: 'text/plain', kind: 'text', url: `/attachments/${SID}/${file}` };
  };
  const onDisk = (att: Attachment) =>
    fs.existsSync(`${store.attachmentsRoot}/${SID}/${att.url.split('/').pop()}`);
  const queue = () => sessions.get(SID)!.queued ?? [];
  const events = () => store.loadTranscript(SID);
  /**
   * Start a real turn, so the session has a query this bridge knows it spawned
   * (`queryTokens`) — canInterject refuses without one. Everything captured
   * during setup is dropped, so assertions see only what the interjection did.
   */
  const live = () => {
    sessions.prompt(SID, 'go');
    pushes.length = 0;
    closes.length = 0;
    return events().length;
  };
  return { sessions, store, broadcasts, stage, onDisk, queue, events, pushes, closes, live };
}

/** Put items straight on the queue — the in-memory meta is the same object get() returns. */
function seed(sessions: SessionManager, items: QueuedPrompt[]) {
  sessions.get(SID)!.queued = items;
}

const item = (over: Partial<QueuedPrompt> = {}): QueuedPrompt => ({
  id: 'q1',
  ts: 1000,
  text: 'original',
  ...over,
});

const range = (label: string): MentionRange => ({
  kind: 'feature',
  id: 'f1',
  label,
  expansion: `- Feature "${label}" (f1)`,
  start: 0,
  end: label.length + 1,
});

describe('editQueued', () => {
  test('replaces text, mentions and draft without moving the item', () => {
    const h = harness();
    seed(h.sessions, [
      item({ id: 'q0', ts: 10, text: 'first' }),
      item({ id: 'q1', ts: 20, text: 'second', actor: ALICE }),
      item({ id: 'q2', ts: 30, text: 'third' }),
    ]);
    const draft = { text: '@Auth check this', ranges: [range('Auth')] };
    const result = h.sessions.editQueued(
      SID,
      'q1',
      {
        text: 'second, expanded',
        mentions: [{ kind: 'feature', id: 'f1', label: 'Auth' }],
        draft,
      },
      { actor: ALICE, isOwner: false },
    );
    assert.equal(result.ok, true);

    const queue = h.queue();
    assert.deepEqual(
      queue.map((q) => q.id),
      ['q0', 'q1', 'q2'],
    );
    const edited = queue[1];
    assert.equal(edited.text, 'second, expanded');
    assert.equal(edited.ts, 20); // FIFO is by ts; an edit is not a re-send
    assert.deepEqual(edited.mentions, [{ kind: 'feature', id: 'f1', label: 'Auth' }]);
    assert.deepEqual(edited.draft, draft);
    assert.equal(edited.actor, ALICE);
    // The author fixed their own prompt: nothing to announce.
    assert.equal(edited.editedAt, undefined);
    assert.equal(edited.editedBy, undefined);
  });

  test('a draft with no ranges is not persisted', () => {
    // `text` is already the draft when there are no pills, and `queued` rides the
    // synced session blob.
    const h = harness();
    seed(h.sessions, [item({ actor: ALICE })]);
    h.sessions.editQueued(
      SID,
      'q1',
      { text: 'plain', draft: { text: 'plain', ranges: [] } },
      { actor: ALICE, isOwner: false },
    );
    assert.equal(h.queue()[0].draft, undefined);
  });

  test('editing does not release a paused queue', () => {
    // The regression that matters most: the owner reviewing a guest's
    // pending-approval prompt must be able to fix it *without* thereby approving
    // it and running it on their machine.
    const h = harness({ queuePaused: true });
    seed(h.sessions, [item({ actor: ALICE })]);
    const result = h.sessions.editQueued(
      SID,
      'q1',
      { text: 'owner tightened this up' },
      { actor: OWNER, isOwner: true },
    );
    assert.equal(result.ok, true);
    assert.equal(h.sessions.get(SID)!.queuePaused, true);
    assert.equal(h.queue().length, 1);
    // Still the guest's prompt, so the released turn is still attributed to them.
    assert.equal(h.queue()[0].actor, ALICE);
  });

  test('an edit by anyone but the author is stamped', () => {
    const h = harness({ queuePaused: true });
    seed(h.sessions, [item({ actor: ALICE })]);
    h.sessions.editQueued(SID, 'q1', { text: 'rewritten' }, { actor: OWNER, isOwner: true });
    const edited = h.queue()[0];
    assert.ok(edited.editedAt);
    assert.deepEqual(edited.editedBy, OWNER);
  });

  test('removing an attachment drops the ref and unlinks the file', () => {
    const h = harness();
    const keep = h.stage('keep.txt');
    const drop = h.stage('drop.txt');
    seed(h.sessions, [item({ actor: ALICE, attachments: [keep, drop] })]);

    const result = h.sessions.editQueued(
      SID,
      'q1',
      { text: 'original', removeAttachments: [drop.url] },
      { actor: ALICE, isOwner: false },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(h.queue()[0].attachments, [keep]);
    assert.equal(h.onDisk(keep), true);
    assert.equal(h.onDisk(drop), false);
  });

  test('added attachments are staged after the kept ones', () => {
    const h = harness();
    const keep = h.stage('keep.txt');
    const drop = h.stage('drop.txt');
    seed(h.sessions, [item({ actor: ALICE, attachments: [keep, drop] })]);

    h.sessions.editQueued(
      SID,
      'q1',
      {
        text: 'original',
        removeAttachments: [drop.url],
        addAttachments: [{ name: 'new.txt', mediaType: 'text/plain', data: 'aGk=' }],
      },
      { actor: ALICE, isOwner: false },
    );
    const attachments = h.queue()[0].attachments!;
    assert.deepEqual(
      attachments.map((a) => a.name),
      ['keep.txt', 'new.txt'],
    );
    assert.equal(h.onDisk(attachments[1]), true);
    assert.equal(h.onDisk(drop), false);
  });

  test('a url the item does not hold is ignored, not deleted', () => {
    // removeAttachments is matched against the item's own refs; treating it as a
    // path would make the message an arbitrary-delete primitive.
    const h = harness();
    const mine = h.stage('mine.txt');
    const other = h.stage('other.txt');
    seed(h.sessions, [item({ actor: ALICE, attachments: [mine] })]);

    h.sessions.editQueued(
      SID,
      'q1',
      { text: 'original', removeAttachments: [other.url] },
      { actor: ALICE, isOwner: false },
    );
    assert.deepEqual(h.queue()[0].attachments, [mine]);
    assert.equal(h.onDisk(other), true);
  });

  describe('who may edit', () => {
    test('the author may edit their own item', () => {
      const h = harness();
      seed(h.sessions, [item({ actor: ALICE })]);
      assert.equal(
        h.sessions.editQueued(SID, 'q1', { text: 'mine' }, { actor: ALICE, isOwner: false }).ok,
        true,
      );
    });

    test('a peer may not rewrite somebody else’s prompt', () => {
      // It would still flush attributed to ALICE — words in her mouth.
      const h = harness();
      seed(h.sessions, [item({ actor: ALICE })]);
      const result = h.sessions.editQueued(
        SID,
        'q1',
        { text: 'not yours' },
        { actor: BOB, isOwner: false },
      );
      assert.equal(result.ok, false);
      assert.equal(h.queue()[0].text, 'original');
    });

    test('the owner may edit anything in their queue', () => {
      const h = harness();
      seed(h.sessions, [item({ actor: ALICE })]);
      assert.equal(
        h.sessions.editQueued(SID, 'q1', { text: 'reviewed' }, { actor: OWNER, isOwner: true }).ok,
        true,
      );
    });

    test('an item with no actor is the owner’s alone', () => {
      // Queued before attribution existed: treat it as the machine owner's.
      const h = harness();
      seed(h.sessions, [item()]);
      assert.equal(
        h.sessions.editQueued(SID, 'q1', { text: 'nope' }, { actor: ALICE, isOwner: false }).ok,
        false,
      );
      assert.equal(
        h.sessions.editQueued(SID, 'q1', { text: 'yes' }, { actor: OWNER, isOwner: true }).ok,
        true,
      );
    });
  });

  test('an unknown id is refused and leaves the queue untouched', () => {
    // The flush-while-editing race: the turn settled and the item went out.
    const h = harness();
    seed(h.sessions, [item({ actor: ALICE })]);
    const before = JSON.stringify(h.queue());
    const result = h.sessions.editQueued(
      SID,
      'gone',
      { text: 'too late' },
      { actor: ALICE, isOwner: false },
    );
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(h.queue()), before);
  });

  test('an edit may not empty the item, but text-free with an attachment is fine', () => {
    const h = harness();
    const att = h.stage('shot.png');
    seed(h.sessions, [item({ actor: ALICE, attachments: [att] })]);

    const emptied = h.sessions.editQueued(
      SID,
      'q1',
      { text: '   ', removeAttachments: [att.url] },
      { actor: ALICE, isOwner: false },
    );
    assert.equal(emptied.ok, false);
    assert.equal(h.queue()[0].text, 'original');
    assert.equal(h.onDisk(att), true); // refused before anything was unlinked

    const imageOnly = h.sessions.editQueued(
      SID,
      'q1',
      { text: '   ' },
      { actor: ALICE, isOwner: false },
    );
    assert.equal(imageOnly.ok, true);
    assert.equal(h.queue()[0].text, '');
    assert.deepEqual(h.queue()[0].attachments, [att]);
  });
});

describe('userPrompt queueing', () => {
  test('a queued prompt keeps its draft, but only when it has pills', () => {
    const h = harness({ queuePaused: undefined });
    const draft = { text: '@Auth review', ranges: [range('Auth')] };
    h.sessions.userPrompt(SID, '@Auth review\n\n---\nexpansion', [], [], {
      needsApproval: true,
      actor: ALICE,
      draft,
    });
    h.sessions.userPrompt(SID, 'no mentions here', [], [], {
      needsApproval: true,
      actor: ALICE,
      draft: { text: 'no mentions here', ranges: [] },
    });
    const queue = h.queue();
    assert.equal(queue.length, 2);
    assert.deepEqual(queue[0].draft, draft);
    assert.equal(queue[1].draft, undefined);
    assert.equal(h.sessions.get(SID)!.queuePaused, true);
  });
});

/**
 * Steer-on-send: a plain composer send while a turn runs goes into that turn,
 * the same delivery "Send now" makes. Every case that cannot steer safely must
 * fall back to the queue, so the worst outcome stays the old behaviour.
 */
describe('userPrompt steering', () => {
  /** Reach the private in-flight sets the gate reads. */
  const flags = (h: ReturnType<typeof harness>) =>
    h.sessions as unknown as {
      compacting: Set<string>;
      interrupting: Set<string>;
      rewinding: Set<string>;
    };

  test('a send into a running turn is pushed, not queued', () => {
    const h = harness();
    const before = h.live();
    const turn = structuredClone(h.sessions.get(SID)!);

    h.sessions.userPrompt(SID, 'also check the tests', [], [], { actor: ALICE });

    assert.equal(h.queue().length, 0);
    assert.deepEqual(h.pushes, [
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'also check the tests' }] },
        parent_tool_use_id: null,
        priority: 'next',
      },
    ]);
    const added = h.events().slice(before);
    // 'interject', never 'user': a 'user' event would split collectTurns.
    assert.deepEqual(
      added.map((e) => e.kind),
      ['interject'],
    );
    assert.equal((added[0].data as { text: string }).text, 'also check the tests');
    assert.deepEqual((added[0].data as { actor?: Actor }).actor, ALICE);
    // Never recycles the query — a rotated token would kill the live turn.
    assert.deepEqual(h.closes, []);
    const after = h.sessions.get(SID)!;
    for (const key of ['turnSource', 'turnStartedAt', 'turnActor', 'status', 'interruptedAt'] as const) {
      assert.deepEqual(after[key], turn[key], `steering moved ${key}`);
    }
  });

  const queues = (name: string, setup: (h: ReturnType<typeof harness>) => void, opts = {}) =>
    test(name, () => {
      const h = harness();
      const before = h.live();
      setup(h);
      h.sessions.userPrompt(SID, 'later', [], [], opts);
      assert.equal(h.queue().at(-1)?.text, 'later');
      assert.equal(h.pushes.length, 0);
      assert.ok(!h.events().slice(before).some((e) => e.kind === 'interject'));
    });

  queues('an explicit queue send waits for the turn', () => {}, { queue: true });
  queues('a prompt that needs approval is held, paused', () => {}, { needsApproval: true });
  queues('an existing queue keeps FIFO — the send goes behind it', (h) => seed(h.sessions, [item()]));
  queues('a compacting turn is never steered', (h) => flags(h).compacting.add(SID));
  queues('a Stop in flight is never steered', (h) => flags(h).interrupting.add(SID));
  queues('a rewind in flight is never steered', (h) => flags(h).rewinding.add(SID));
  queues('a session waiting on permission is not steered', (h) => {
    h.sessions.get(SID)!.status = 'waiting-permission';
  });
  queues('a workflow mid-advance is not steered', (h) => {
    h.sessions.get(SID)!.workflow = { advancing: true } as SessionMeta['workflow'];
  });

  test('needsApproval pauses the queue', () => {
    const h = harness();
    h.live();
    h.sessions.userPrompt(SID, 'later', [], [], { needsApproval: true });
    assert.equal(h.sessions.get(SID)!.queuePaused, true);
  });

  test('an existing queue is queued behind, in order', () => {
    const h = harness();
    h.live();
    seed(h.sessions, [item({ id: 'q1' })]);
    h.sessions.userPrompt(SID, 'later');
    assert.deepEqual(
      h.queue().map((q) => q.text),
      ['original', 'later'],
    );
  });

  test('a send with attachments queues and stages them', () => {
    const h = harness();
    h.live();
    h.sessions.userPrompt(SID, 'look', [{ name: 'a.txt', mediaType: 'text/plain', data: 'YQ==' }]);
    assert.equal(h.queue().length, 1);
    assert.equal(h.queue()[0].attachments?.length, 1);
    assert.equal(h.pushes.length, 0);
  });

  test('a closed worker link queues rather than buffering into a future query', () => {
    const h = harness({}, { linkOpen: false });
    h.live();
    h.sessions.userPrompt(SID, 'later');
    assert.equal(h.queue().length, 1);
    assert.equal(h.pushes.length, 0);
  });

  test('an idle session opens a turn as before', () => {
    const h = harness({ status: 'idle' });
    const before = h.events().length;
    h.sessions.userPrompt(SID, 'hello');
    assert.equal(h.queue().length, 0);
    assert.ok(h.events().slice(before).some((e) => e.kind === 'user'));
  });
});

describe('cancelQueued', () => {
  test('dropping an item unlinks its attachments and leaves the others alone', () => {
    const h = harness();
    const mine = h.stage('mine.txt');
    const theirs = h.stage('theirs.txt');
    seed(h.sessions, [
      item({ id: 'q1', attachments: [mine] }),
      item({ id: 'q2', attachments: [theirs] }),
    ]);

    h.sessions.cancelQueued(SID, 'q1');
    assert.deepEqual(
      h.queue().map((q) => q.id),
      ['q2'],
    );
    assert.equal(h.onDisk(mine), false);
    assert.equal(h.onDisk(theirs), true);
  });

  test('emptying the queue clears the pause', () => {
    const h = harness({ queuePaused: true });
    seed(h.sessions, [item()]);
    h.sessions.cancelQueued(SID, 'q1');
    assert.equal(h.queue().length, 0);
    assert.equal(h.sessions.get(SID)!.queuePaused, undefined);
  });
});

/**
 * "Send now": a queued prompt delivered into the turn that is already running.
 *
 * Two failure modes drive most of these cases. A refusal must leave the item
 * queued, so the worst outcome is always the pre-existing behaviour (it flushes
 * when the turn settles). And the push must never rotate the access token, since
 * pushWithToken closes the query on a mismatch — which would silently *end* the
 * turn the interjection was joining.
 */
describe('interjectQueued', () => {
  const send = (h: ReturnType<typeof harness>, id = 'q1', needsApproval = false) =>
    h.sessions.interjectQueued(SID, id, { actor: OWNER, needsApproval });

  test('delivers into the live turn without opening a new one', () => {
    const h = harness();
    const before = h.live();
    seed(h.sessions, [item({ text: 'also check the tests' })]);

    assert.deepEqual(send(h), { ok: true });
    assert.equal(h.queue().length, 0);

    assert.equal(h.pushes.length, 1);
    assert.deepEqual(h.pushes[0], {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'also check the tests' }] },
      parent_tool_use_id: null,
      // Measured, not chosen: 'now' makes the CLI end the running turn and start
      // a new one (two results). See the comment in interjectQueued.
      priority: 'next',
    });

    const added = h.events().slice(before);
    assert.deepEqual(
      added.map((e) => e.kind),
      ['interject'],
    );
    assert.equal((added[0].data as { text: string }).text, 'also check the tests');
  });

  test('runs as its author, not as whoever pressed the button', () => {
    const h = harness();
    const before = h.live();
    seed(h.sessions, [item({ actor: BOB, mentions: [] })]);

    // The owner releases Bob's prompt; the transcript must still credit Bob.
    assert.deepEqual(send(h), { ok: true });
    const added = h.events().slice(before);
    assert.deepEqual((added[0].data as { actor?: Actor }).actor, BOB);
  });

  test('leaves every turn field alone', () => {
    const h = harness();
    h.live();
    seed(h.sessions, [item()]);
    const before = structuredClone(h.sessions.get(SID)!);

    assert.deepEqual(send(h), { ok: true });

    const after = h.sessions.get(SID)!;
    for (const key of [
      'turnSource',
      'turnStartedAt',
      'turnActor',
      'status',
      'interruptedAt',
      'workflow',
    ] as const) {
      assert.deepEqual(after[key], before[key], `interjection moved ${key}`);
    }
  });

  test('never recycles the query — a rotated token would kill the live turn', () => {
    const h = harness();
    h.live();
    seed(h.sessions, [item()]);
    assert.deepEqual(send(h), { ok: true });
    assert.deepEqual(h.closes, []);
  });

  test('the rest of the queue keeps waiting for the turn', () => {
    const h = harness();
    h.live();
    seed(h.sessions, [item({ id: 'q1' }), item({ id: 'q2', text: 'later' })]);

    assert.deepEqual(send(h, 'q2'), { ok: true });
    assert.deepEqual(
      h.queue().map((q) => q.id),
      ['q1'],
    );
    // One push, not two: no maybeFlush side effect.
    assert.equal(h.pushes.length, 1);
  });

  test('releasing one item is not a release of the queue', () => {
    const h = harness({ queuePaused: true });
    h.live();
    seed(h.sessions, [item({ id: 'q1' }), item({ id: 'q2' })]);
    assert.deepEqual(send(h, 'q2'), { ok: true });
    assert.equal(h.sessions.get(SID)!.queuePaused, true);
  });

  test('emptying the queue clears the pause', () => {
    const h = harness({ queuePaused: true });
    h.live();
    seed(h.sessions, [item()]);
    assert.deepEqual(send(h), { ok: true });
    assert.equal(h.sessions.get(SID)!.queuePaused, undefined);
  });

  for (const status of ['idle', 'done', 'waiting-approval'] as const) {
    test(`a ${status} session is 'settled' and the item stays queued`, () => {
      const h = harness();
      const before = h.live();
      h.sessions.get(SID)!.status = status;
      seed(h.sessions, [item()]);

      const res = send(h);
      assert.equal(res.ok, false);
      assert.equal(res.ok === false && res.code, 'settled');
      assert.equal(h.queue().length, 1);
      assert.equal(h.pushes.length, 0);
      assert.equal(h.events().length, before);
    });
  }

  test('a guest whose prompts need approval cannot release their own', () => {
    const h = harness();
    const before = h.live();
    seed(h.sessions, [item({ actor: ALICE })]);

    const res = h.sessions.interjectQueued(SID, 'q1', { actor: ALICE, needsApproval: true });
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.code, 'refused');
    assert.equal(h.queue().length, 1);
    assert.equal(h.pushes.length, 0);
    // Nothing emitted either: the refusal is the first line, before any write.
    assert.equal(h.events().length, before);
  });

  test('an item with attachments is refused and keeps its staged file', () => {
    const h = harness();
    h.live();
    const att = h.stage('notes.txt');
    seed(h.sessions, [item({ attachments: [att] })]);

    const res = send(h);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.code, 'refused');
    assert.equal(h.queue().length, 1);
    assert.equal(h.onDisk(att), true);
    assert.equal(h.pushes.length, 0);
  });

  test('an unknown id leaves the queue untouched', () => {
    const h = harness();
    h.live();
    seed(h.sessions, [item()]);
    const res = send(h, 'nope');
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.code, 'refused');
    assert.equal(h.queue().length, 1);
    assert.equal(h.pushes.length, 0);
  });

  test('a closed worker link refuses rather than buffering into a future query', () => {
    const h = harness({}, { linkOpen: false });
    h.live();
    seed(h.sessions, [item()]);
    const res = send(h);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.code, 'settled');
    assert.equal(h.queue().length, 1);
    assert.equal(h.pushes.length, 0);
  });
});

/**
 * The fold a "Keep planning" click performs. Its whole reason for existing is
 * that a keep-planning deny never settles the turn, so these rows have no other
 * way out — see resolvePermission and sessions.permission.test.ts for the deny
 * end of it.
 */
describe('takeQueuedPlanReply', () => {
  const take = (h: ReturnType<typeof harness>, actor?: Actor) =>
    (
      h.sessions as unknown as {
        takeQueuedPlanReply(meta: SessionMeta, actor?: Actor): string[];
      }
    ).takeQueuedPlanReply(h.sessions.get(SID)!, actor);

  test('folds a text-only item and removes its row', () => {
    const h = harness();
    seed(h.sessions, [item({ text: '  add a rollback step  ' })]);

    const before = h.broadcasts.length;
    assert.deepEqual(take(h), ['add a rollback step']);
    assert.deepEqual(h.queue(), []);
    // Broadcast before the caller resolves: no client may render a row the model
    // has already been handed.
    assert.ok(h.broadcasts.length > before);
  });

  test('folds the whole leading run, in order', () => {
    const h = harness();
    seed(h.sessions, [
      item({ id: 'q0', text: 'first' }),
      item({ id: 'q1', text: 'second' }),
      item({ id: 'q2', text: 'third' }),
    ]);

    assert.deepEqual(take(h), ['first', 'second', 'third']);
    assert.deepEqual(h.queue(), []);
  });

  test('a paused queue is left intact', () => {
    // A guest's held prompt waits for the owner's release, never for a button
    // that was aimed at the plan card.
    const h = harness({ queuePaused: true });
    seed(h.sessions, [item({ text: 'held' })]);

    const before = h.broadcasts.length;
    assert.deepEqual(take(h), []);
    assert.equal(h.queue().length, 1);
    assert.equal(h.broadcasts.length, before);
  });

  test('a foreign-authored item stops the walk and keeps FIFO', () => {
    const h = harness();
    seed(h.sessions, [
      item({ id: 'q0', text: 'mine', actor: ALICE }),
      item({ id: 'q1', text: 'theirs', actor: BOB }),
      item({ id: 'q2', text: 'mine again', actor: ALICE }),
    ]);

    assert.deepEqual(take(h, ALICE), ['mine']);
    assert.deepEqual(
      h.queue().map((q) => q.id),
      ['q1', 'q2'],
    );
  });

  test('an unattributed item belongs to the machine owner', () => {
    const h = harness();
    seed(h.sessions, [
      item({ id: 'q0', text: 'owner wrote this' }),
      item({ id: 'q1', text: 'guest', actor: ALICE }),
    ]);

    assert.deepEqual(take(h), ['owner wrote this']);
    assert.deepEqual(
      h.queue().map((q) => q.id),
      ['q1'],
    );
  });

  test('an attachments item keeps its row with the text stripped, and stops the walk', () => {
    const h = harness();
    const att = h.stage('shot.png');
    seed(h.sessions, [
      item({
        id: 'q0',
        text: 'look at this',
        attachments: [att],
        mentions: [{ kind: 'feature', id: 'f1', label: 'Auth' }],
        draft: { text: '@Auth look at this', ranges: [range('Auth')] },
      }),
      item({ id: 'q1', text: 'after' }),
    ]);

    assert.deepEqual(take(h), ['look at this']);
    const [row] = h.queue();
    assert.equal(row.id, 'q0', 'the row holds its place so the file still arrives in order');
    assert.equal(row.text, '');
    assert.equal(row.mentions, undefined);
    assert.equal(row.draft, undefined);
    assert.deepEqual(row.attachments, [att]);
    assert.equal(h.onDisk(att), true);
    assert.equal(h.queue().length, 2, 'the walk stopped at the attachments row');
  });

  test('an attachment-only row is left completely alone', () => {
    const h = harness();
    const att = h.stage('shot.png');
    seed(h.sessions, [item({ text: '', attachments: [att] })]);

    const before = h.broadcasts.length;
    assert.deepEqual(take(h), []);
    assert.equal(h.queue().length, 1);
    assert.equal(h.broadcasts.length, before, 'nothing changed, so nothing to broadcast');
  });

  test('an empty queue folds to nothing', () => {
    const h = harness();
    const before = h.broadcasts.length;
    assert.deepEqual(take(h), []);
    assert.equal(h.broadcasts.length, before);
  });
});
