import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionMeta } from '@lines/shared';
import {
  mergeMachineSessions,
  prunableDraftIds,
  shouldClaimSelection,
} from '../../web/src/lib/machines.ts';

/**
 * Holding two machines at once.
 *
 * Every rule here replaces one that was correct for a single machine and is
 * destructive for two: replace-the-whole-map, prune-every-orphan-draft,
 * select-anything-new. The plan calls scoped draft pruning out by name — it
 * deletes text the user typed and never sent, which nothing can recover.
 */

const s = (id: string): SessionMeta => ({ id, name: id }) as SessionMeta;
const ids = (map: Record<string, SessionMeta>) => Object.keys(map).sort();

describe('mergeMachineSessions', () => {
  test("a machine's hello does not remove another machine's sessions", () => {
    // The single-machine reducer replaced the map wholesale, so whichever machine
    // said hello last won and the other's sessions vanished from the sidebar.
    const out = mergeMachineSessions({
      sessions: { mine: s('mine'), theirs: s('theirs') },
      sessionMachine: { mine: 'A', theirs: 'B' },
      deviceId: 'A',
      incoming: [s('mine')],
    });
    assert.deepEqual(ids(out.sessions), ['mine', 'theirs']);
    assert.equal(out.sessionMachine.theirs, 'B', "B's stamp must survive A's hello");
  });

  test('a session the machine stopped reporting is dropped, but only its own', () => {
    const out = mergeMachineSessions({
      sessions: { gone: s('gone'), kept: s('kept'), other: s('other') },
      sessionMachine: { gone: 'A', kept: 'A', other: 'B' },
      deviceId: 'A',
      incoming: [s('kept')],
    });
    assert.deepEqual(ids(out.sessions), ['kept', 'other']);
  });

  test('unstamped sessions are adopted by the hello that reports them', () => {
    // First connection, and the upgrade path from a single-machine client: the
    // existing map has no stamps at all.
    const out = mergeMachineSessions({
      sessions: { a: s('a') },
      sessionMachine: {},
      deviceId: 'A',
      incoming: [s('a'), s('b')],
    });
    assert.equal(out.sessionMachine.a, 'A');
    assert.equal(out.sessionMachine.b, 'A');
  });

  test('an unstamped session no hello claims is kept, not guessed away', () => {
    // It may belong to a machine whose link has not opened yet. Dropping it would
    // make sessions flicker out of the sidebar on every reconnect.
    const out = mergeMachineSessions({
      sessions: { orphan: s('orphan') },
      sessionMachine: {},
      deviceId: 'A',
      incoming: [],
    });
    assert.deepEqual(ids(out.sessions), ['orphan']);
  });

  test('two machines merging in sequence end up with both sets', () => {
    let state = { sessions: {} as Record<string, SessionMeta>, sessionMachine: {} as Record<string, string> };
    state = mergeMachineSessions({ ...state, deviceId: 'A', incoming: [s('a1'), s('a2')] });
    state = mergeMachineSessions({ ...state, deviceId: 'B', incoming: [s('b1')] });
    assert.deepEqual(ids(state.sessions), ['a1', 'a2', 'b1']);
    assert.deepEqual(state.sessionMachine, { a1: 'A', a2: 'A', b1: 'B' });

    // And a re-hello from A must not disturb B.
    state = mergeMachineSessions({ ...state, deviceId: 'A', incoming: [s('a1')] });
    assert.deepEqual(ids(state.sessions), ['a1', 'b1']);
  });

  test('the incoming copy wins for a session this machine owns', () => {
    const out = mergeMachineSessions({
      sessions: { a: { ...s('a'), name: 'stale' } as SessionMeta },
      sessionMachine: { a: 'A' },
      deviceId: 'A',
      incoming: [{ ...s('a'), name: 'fresh' } as SessionMeta],
    });
    assert.equal(out.sessions.a.name, 'fresh');
  });
});

describe('prunableDraftIds', () => {
  test("never prunes a draft belonging to another machine's session", () => {
    assert.deepEqual(
      prunableDraftIds({
        draftIds: ['mine-gone', 'theirs'],
        sessionMachine: { 'mine-gone': 'A', theirs: 'B' },
        deviceId: 'A',
        live: new Set(),
      }),
      ['mine-gone'],
    );
  });

  test('never prunes a draft for a session it has never seen', () => {
    // The destructive case: a machine that has not connected yet owns this
    // session, so an unscoped prune would delete unsent text for it.
    assert.deepEqual(
      prunableDraftIds({
        draftIds: ['unknown'],
        sessionMachine: {},
        deviceId: 'A',
        live: new Set(),
      }),
      [],
    );
  });

  test('keeps a draft whose session is still live', () => {
    assert.deepEqual(
      prunableDraftIds({
        draftIds: ['a'],
        sessionMachine: { a: 'A' },
        deviceId: 'A',
        live: new Set(['a']),
      }),
      [],
    );
  });
});

describe('shouldClaimSelection', () => {
  const base = { fromPrimary: true, pendingCreate: true, alreadySeen: false };

  test('selects a session this client asked for on the machine in front of it', () => {
    assert.equal(shouldClaimSelection(base), true);
  });

  test('never steals the view for a session created on another machine', () => {
    // The host creating a session on their own laptop must not yank a guest's
    // view across to it mid-sentence.
    assert.equal(shouldClaimSelection({ ...base, fromPrimary: false }), false);
  });

  test('ignores a session this client did not ask for', () => {
    assert.equal(shouldClaimSelection({ ...base, pendingCreate: false }), false);
  });

  test('a session this browser already knows is never new again', () => {
    // createdAt is stamped on the bridge machine, so a clock slightly ahead made
    // every upsert look freshly created; this is the half that fixed it.
    assert.equal(shouldClaimSelection({ ...base, alreadySeen: true }), false);
  });
});
