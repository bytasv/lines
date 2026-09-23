import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ServerMessage, SessionMeta } from '@lines/shared';
import {
  emptyMachine,
  emptyView,
  machineView,
  mergeMachineSessions,
  prunableDraftIds,
  sessionsOnMachine,
  shouldClaimSelection,
  type MachineSlice,
  type MachineView,
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

/**
 * The owner-state half, which is what made the sidebar flicker.
 *
 * The bridge already sends a guest a *thin* `hello` — sessions and nothing else
 * — and the client used to write every field of it into one global set. A shared
 * machine's hello therefore blanked the projects, the library and the account of
 * the machine the user was looking at, and that machine's next hello put them
 * back. The store applies a view to the globals only when it came from the
 * primary machine; these tests pin the pure half that makes that possible.
 */
const hello = (over: Partial<Extract<ServerMessage, { type: 'hello' }>> = {}) =>
  ({
    type: 'hello',
    sessions: [],
    workflows: [],
    sharedWorkflows: [],
    steps: [],
    sharedSteps: [],
    pinnedSteps: [],
    recipes: [],
    sharedRecipes: [],
    recipeStats: {},
    models: [],
    recentDirs: [],
    projects: [],
    projectKeys: {},
    usage: null,
    auth: { loggedIn: false },
    storage: { available: true },
    ...over,
  }) as Extract<ServerMessage, { type: 'hello' }>;

/** The store's rule, restated: a hello only ever writes its own machine's slice. */
const applyHello = (
  machines: Record<string, MachineSlice>,
  from: string,
  msg: Extract<ServerMessage, { type: 'hello' }>,
): Record<string, MachineSlice> => {
  const prev = machines[from] ?? emptyMachine(from);
  return { ...machines, [from]: { ...prev, bootstrapped: true, view: machineView(msg, prev.view) } };
};

describe('machineView', () => {
  const owner = hello({
    projects: [{ path: '/repo' }],
    projectKeys: { '/repo': 'key' },
    auth: { loggedIn: true },
    usage: { pct: 12 } as never,
  });
  /** What a guest connection actually receives: sessions, and no owner state. */
  const guest = hello({
    access: { scope: 'machine', caps: {} as never, ownerProfile: null, deviceId: 'B' },
  });

  test("a second machine's hello leaves the primary's view untouched", () => {
    let machines = applyHello({}, 'A', owner);
    const before = machines.A.view;
    machines = applyHello(machines, 'B', guest);
    assert.equal(machines.A.view, before, "A's view must not be rebuilt by B's hello");
    assert.deepEqual(machines.A.view.projects, [{ path: '/repo' }]);
    assert.deepEqual(machines.A.view.projectKeys, { '/repo': 'key' });
    assert.equal(machines.A.view.access, null, 'A is our own machine');
    assert.equal(machines.A.view.auth?.loggedIn, true);
    assert.ok(machines.A.view.usage, "the primary's usage snapshot survives");
    // And the guest's own slice describes the guest connection, not A's state.
    assert.deepEqual(machines.B.view.projects, []);
    assert.ok(machines.B.view.access, 'B is somebody else’s machine');
  });

  test('a repeated non-primary hello is inert against the primary too', () => {
    // The duplicate-hello guard cannot damp this one: the relay replays `open`
    // for every live channel when a bridge attaches, so a guest hello arrives
    // again with nothing new in it.
    let machines = applyHello({}, 'A', owner);
    const before = machines.A.view;
    machines = applyHello(applyHello(machines, 'B', guest), 'B', guest);
    assert.equal(machines.A.view, before);
    assert.deepEqual(machines.A.view.projects, [{ path: '/repo' }]);
  });

  test('a bridge restart keeps the last good usage snapshot — its own', () => {
    // The carry-forward reads the machine's previous view, never the globals:
    // reading globals made a second machine inherit the first machine's chip.
    const prev: MachineView = { ...emptyView(), usage: { pct: 40 } as never };
    const restarted = machineView(hello({ auth: { loggedIn: true } }), prev);
    assert.deepEqual(restarted.usage, { pct: 40 });
    // But it is dropped once the account behind it is gone.
    assert.equal(machineView(hello({ auth: { loggedIn: false } }), prev).usage, null);
  });

  test('switching machines swaps the whole view from the new slice', () => {
    // `setPrimaryMachine` spreads exactly this object over the globals — every
    // field of a view is named after its global counterpart — so a switch and a
    // primary hello project the same set of fields and cannot drift apart.
    const machines = applyHello(applyHello({}, 'A', owner), 'B', guest);
    assert.deepEqual(Object.keys(machines.B.view).sort(), Object.keys(emptyView()).sort());
    assert.deepEqual(machines.B.view.projects, []);
    assert.equal(machines.B.view.auth?.loggedIn, false);
  });

  test("a session share's tabs come from the sessions shared with us", () => {
    // A session guest's hello carries `projects: []` by design; without derived
    // tabs a switch to that machine had nothing to select and listed nothing.
    const sessions = [
      { ...s('a'), cwd: '/repo' },
      { ...s('b'), cwd: '/wt/feature' },
      { ...s('c'), cwd: '/other' },
      { ...s('d'), cwd: '/other' },
    ];
    const view = machineView(
      hello({
        access: { scope: 'session', caps: {} as never, ownerProfile: null, deviceId: 'B' },
        sessions,
        projectKeys: { '/repo': 'k', '/wt/feature': 'k' },
      }),
      emptyView(),
    );
    // The work tree folds into its repo's tab by key.
    assert.deepEqual(view.projects, [{ path: '/other' }, { path: '/repo' }]);
  });

  test("a machine share's tabs are the host's real projects", () => {
    // Sessions are created in them, so a project with none yet still needs a tab.
    const view = machineView(
      hello({
        ...guest,
        sessions: [{ ...s('a'), cwd: '/repo' }],
        projects: [{ path: '/repo' }, { path: '/empty' }],
      }),
      emptyView(),
    );
    assert.deepEqual(view.projects, [{ path: '/repo' }, { path: '/empty' }]);
  });

  test('bare path strings from an old bridge still become projects', () => {
    // `hello` carries no protocol version, so a tab left open across the upgrade
    // renders `[object Object]` tabs without this.
    const view = machineView(hello({ projects: ['/old'] as never }), emptyView());
    assert.deepEqual(view.projects, [{ path: '/old' }]);
  });
});

describe('sessionsOnMachine', () => {
  const sessions = { a1: s('a1'), a2: s('a2'), b1: s('b1') };

  test('lists one machine at a time', () => {
    const stamps = { a1: 'A', a2: 'A', b1: 'B' };
    assert.deepEqual(ids(sessionsOnMachine(sessions, stamps, 'A')), ['a1', 'a2']);
    assert.deepEqual(ids(sessionsOnMachine(sessions, stamps, 'B')), ['b1']);
  });

  test("a direct local bridge's empty device id is a machine like any other", () => {
    // Local installs stamp '' and have no primary device id at all, so callers
    // pass `primaryDeviceId ?? ''` — nothing there may be filtered out.
    assert.deepEqual(ids(sessionsOnMachine(sessions, { a1: '', a2: '', b1: '' }, '')), [
      'a1',
      'a2',
      'b1',
    ]);
  });

  test('an unstamped session shows on the machine being asked about', () => {
    // Same "keep rather than guess" rule as mergeMachineSessions: a session no
    // hello has claimed yet must not vanish from every list at once.
    assert.deepEqual(ids(sessionsOnMachine(sessions, { b1: 'B' }, 'A')), ['a1', 'a2']);
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
