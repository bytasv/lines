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
    model: 'claude-opus-5',
    permissionMode: 'default',
    // Busy, so userPrompt takes the queue branch instead of starting a real turn.
    status: 'running',
    createdAt: 1,
    ...over,
  }) as SessionMeta;

/** A manager over a throwaway store, seeded with one session. */
function harness(over: Partial<SessionMeta> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-queue-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta(over)]));
  const store = createStore(root);
  const broadcasts: ServerMessage[] = [];
  const sessions = new SessionManager(store, new GuardAllowlist(store), (m) => broadcasts.push(m));
  /** Write a real attachment file and return the ref a queued item would hold. */
  const stage = (name: string): Attachment => {
    const file = store.saveAttachment(SID, name, Buffer.from(name).toString('base64'));
    return { name, mediaType: 'text/plain', kind: 'text', url: `/attachments/${SID}/${file}` };
  };
  const onDisk = (att: Attachment) =>
    fs.existsSync(`${store.attachmentsRoot}/${SID}/${att.url.split('/').pop()}`);
  const queue = () => sessions.get(SID)!.queued ?? [];
  return { sessions, store, broadcasts, stage, onDisk, queue };
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
