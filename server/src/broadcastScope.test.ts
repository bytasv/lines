import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ServerMessage, SessionMeta, SocketAccess, UsageSnapshot, UserUiSettings } from '@lines/shared';
import { OWNER_ACCESS, capsForPreset, sanitizeSessionLayout } from '@lines/shared';
import { guestPayloadFor, guestUsage, mayReceive, sessionIdOf } from './userContext.ts';

/**
 * Who a broadcast reaches.
 *
 * `UserContext.broadcast` serializes once and fans out to every socket on the
 * context. With sharing, a guest's socket sits on the *host's* context, so an
 * unscoped fan-out would stream the host's other sessions — and their settings,
 * usage and project paths — straight to someone who was given one session.
 *
 * Both halves of the rule are imported rather than restated: `sessionIdOf`, which
 * is the input everything turns on, and `mayReceive` itself.
 */

const meta = (id: string): SessionMeta => ({ id }) as SessionMeta;

/** One representative of every broadcast shape the bridge sends. */
const SESSION_BEARING: ServerMessage[] = [
  { type: 'sessionUpsert', session: meta('s1') } as ServerMessage,
  { type: 'sessionDeleted', sessionId: 's1' } as ServerMessage,
  { type: 'stream', sessionId: 's1' } as unknown as ServerMessage,
  { type: 'error', sessionId: 's1', message: 'x' } as ServerMessage,
  { type: 'turnSpend', sessionId: 's1', spend: { costUsd: 0.01, tokens: 100 } } as ServerMessage,
];

const ACCOUNT_WIDE: ServerMessage[] = [
  { type: 'settings', settings: {} } as ServerMessage,
  { type: 'workflows', workflows: [] } as ServerMessage,
  { type: 'steps', steps: [] } as unknown as ServerMessage,
  { type: 'usage', usage: null } as unknown as ServerMessage,
  { type: 'openaiUsage', usage: null } as unknown as ServerMessage,
  { type: 'authStatus', auth: { loggedIn: true } } as unknown as ServerMessage,
  { type: 'guardAllowlist', entries: [] } as unknown as ServerMessage,
  // Names and URLs of the host's third-party servers — account-wide, so a guest
  // socket never receives it.
  { type: 'mcpConnections', connections: [] } as unknown as ServerMessage,
  { type: 'mcpConnectionsReview', review: null } as unknown as ServerMessage,
  // Statuses for several sessions at once. Keyed inside the payload precisely so
  // it lands here: a top-level sessionId would make it session-scoped, and a
  // guest would be handed the host's third-party server names and errors.
  { type: 'mcpStatuses', statuses: {} } as unknown as ServerMessage,
  { type: 'projects', projects: [] } as unknown as ServerMessage,
];

describe('sessionIdOf', () => {
  test('a session-bearing message resolves to its session', () => {
    for (const msg of SESSION_BEARING) {
      assert.equal(sessionIdOf(msg), 's1', `${msg.type} must resolve to its session`);
    }
  });

  test('sessionUpsert resolves through the nested session, not a top-level field', () => {
    // The one message that carries its id inside a blob. Missing this would make
    // every session upsert look account-wide, which the rule below denies to
    // guests — a shared session would simply never update on their screen.
    assert.equal(sessionIdOf({ type: 'sessionUpsert', session: meta('abc') } as ServerMessage), 'abc');
  });

  test('account-wide messages resolve to null', () => {
    for (const msg of ACCOUNT_WIDE) {
      assert.equal(sessionIdOf(msg), null, `${msg.type} must not look session-scoped`);
    }
  });
});

/** The real rule, imported rather than restated, so the two cannot drift. */
const mayReceiveMsg = (msg: ServerMessage, access: SocketAccess): boolean =>
  mayReceive(msg, sessionIdOf(msg), access);

const scoped = (sessionIds: string[]): SocketAccess => ({
  scope: 'session',
  caps: capsForPreset('collaborator', 'session'),
  sessionIds,
});

describe('broadcast scope', () => {
  test('the owner receives everything', () => {
    for (const msg of [...SESSION_BEARING, ...ACCOUNT_WIDE]) {
      assert.equal(mayReceiveMsg(msg, OWNER_ACCESS), true, `owner must receive ${msg.type}`);
    }
  });

  test("a session guest never receives the host's account state", () => {
    // Any one of these would leak something real: project paths, the host's Claude
    // account, their whole workflow library, their token spend.
    for (const msg of ACCOUNT_WIDE) {
      assert.equal(mayReceiveMsg(msg, scoped(['s1'])), false, `a guest must not receive ${msg.type}`);
    }
  });

  test('a session guest receives only their own session', () => {
    for (const msg of SESSION_BEARING) {
      assert.equal(mayReceiveMsg(msg, scoped(['s1'])), true);
      assert.equal(mayReceiveMsg(msg, scoped(['other'])), false, `${msg.type} leaked across sessions`);
    }
  });

  test('machine health still reaches a guest', () => {
    // The exception, and it earns it: a guest whose turns are about to fail needs
    // to know the worker is down, and neither message carries anything private.
    const guest = scoped(['s1']);
    assert.equal(mayReceiveMsg({ type: 'workerStatus', worker: { connected: false } } as ServerMessage, guest), true);
    assert.equal(
      mayReceiveMsg({ type: 'storageStatus', storage: { available: false } } as ServerMessage, guest),
      true,
    );
  });

  test('a machine guest gets every session, the projects, the workflow library, plan usage and the sidebar layout, but no other account state', () => {
    const machine: SocketAccess = { scope: 'machine', caps: capsForPreset('collaborator', 'machine') };
    // Plan usage is sent cut down to `guestUsage`, settings to the sidebar layout
    // (see the tests below).
    const allowed = new Set(['projects', 'projectKeys', 'workflows', 'usage', 'openaiUsage', 'settings']);
    for (const msg of SESSION_BEARING) assert.equal(mayReceiveMsg(msg, machine), true);
    for (const msg of ACCOUNT_WIDE) {
      assert.equal(mayReceiveMsg(msg, machine), allowed.has(msg.type), msg.type);
    }
    assert.equal(
      mayReceiveMsg({ type: 'projectKeys', projectKeys: {} } as ServerMessage, machine),
      true,
    );
    // A session share still gets neither: it has no folder to work in.
    assert.equal(
      mayReceiveMsg({ type: 'projectKeys', projectKeys: {} } as ServerMessage, scoped(['s1'])),
      false,
    );
  });

  test('the workflow library reaches only a machine guest who may create sessions', () => {
    const library: ServerMessage[] = [
      { type: 'workflows', workflows: [] } as ServerMessage,
      { type: 'sharedWorkflows', workflows: [] } as ServerMessage,
    ];
    const full: SocketAccess = { scope: 'machine', caps: capsForPreset('full', 'machine') };
    const machineView: SocketAccess = { scope: 'machine', caps: capsForPreset('view', 'machine') };
    for (const msg of library) {
      assert.equal(mayReceiveMsg(msg, full), true, `full machine guest must receive ${msg.type}`);
      assert.equal(mayReceiveMsg(msg, machineView), false, `view-only machine guest got ${msg.type}`);
      assert.equal(mayReceiveMsg(msg, scoped(['s1'])), false, `session guest got ${msg.type}`);
    }
    // Step libraries stay owner-only: their client reducers are not per machine.
    assert.equal(mayReceiveMsg({ type: 'steps', steps: [] } as unknown as ServerMessage, full), false);
  });
});

describe('guest plan usage', () => {
  const snapshot: UsageSnapshot = {
    windows: [{ id: 'five_hour', utilization: 42, resetsAt: null }],
    fetchedAt: 1000,
    plan: 'Max 20x',
    limitReached: false,
    credits: { enabled: true, usedMinor: 500, limitMinor: 10000, currency: 'USD' },
    resetCreditsAvailable: 2,
    resetCreditsApplicable: 1,
  };

  test('guestUsage keeps the windows and plan, and drops the money', () => {
    assert.deepEqual(guestUsage(snapshot), {
      windows: snapshot.windows,
      fetchedAt: 1000,
      plan: 'Max 20x',
      limitReached: false,
    });
  });

  test('guestUsage of no reading is no reading', () => {
    assert.equal(guestUsage(null), null);
  });

  test('a guest socket is sent the sanitized usage broadcast', () => {
    for (const type of ['usage', 'openaiUsage'] as const) {
      const msg = { type, usage: snapshot } as ServerMessage;
      const payload = JSON.parse(JSON.stringify(guestPayloadFor(msg)));
      assert.equal(payload.type, type);
      assert.equal(payload.usage.credits, undefined, `${type} leaked credits`);
      assert.equal(payload.usage.resetCreditsAvailable, undefined);
      assert.equal(payload.usage.resetCreditsApplicable, undefined);
      assert.deepEqual(payload.usage.windows, snapshot.windows);
    }
  });

  test('other broadcasts reach a guest unchanged', () => {
    assert.equal(guestPayloadFor({ type: 'projects', projects: [] } as unknown as ServerMessage), undefined);
    assert.equal(guestPayloadFor({ type: 'sessionDeleted', sessionId: 's1' } as ServerMessage), undefined);
  });
});

describe('guest sidebar layout', () => {
  const settings: UserUiSettings = {
    sessionGroups: { 'github.com/acme/app': [{ id: 'g1', name: 'For future', muted: true }] },
    sessionOrder: { 'github.com/acme/app': ['s2', 's1'] },
    alertSound: 'chime',
    dismissedCheckouts: ['/Users/owner/private'],
    smartRouting: { mode: 'auto', rules: {} },
    updatedAt: 5,
  };

  test('a guest socket gets the groups and manual order, and nothing else from settings', () => {
    const payload = JSON.parse(JSON.stringify(guestPayloadFor({ type: 'settings', settings } as ServerMessage)));
    assert.deepEqual(payload, {
      type: 'sessionLayout',
      layout: { sessionGroups: settings.sessionGroups, sessionOrder: settings.sessionOrder },
    });
  });

  test('settings with no layout still go out as an empty layout, never whole', () => {
    const payload = guestPayloadFor({ type: 'settings', settings: { alertSound: 'chime' } } as ServerMessage);
    assert.deepEqual(payload, { type: 'sessionLayout', layout: { sessionGroups: {}, sessionOrder: {} } });
  });

  test('a session guest gets no layout at all', () => {
    assert.equal(mayReceiveMsg({ type: 'settings', settings } as ServerMessage, scoped(['s1'])), false);
  });

  test('sanitizeSessionLayout keeps only well-formed groups and ids, within the layout keys', () => {
    const clean = sanitizeSessionLayout({
      sessionGroups: {
        p: [{ id: 'g1', name: 'A', muted: true, extra: 'x' }, { id: '', name: 'bad' }, { name: 'no id' }, 'junk'],
        '': [{ id: 'g2', name: 'empty key' }],
      },
      sessionOrder: { p: ['s1', 2, '', 's2'] },
      alertSound: 'hijack',
    });
    assert.deepEqual(clean, {
      sessionGroups: { p: [{ id: 'g1', name: 'A', muted: true }] },
      sessionOrder: { p: ['s1', 's2'] },
    });
    assert.deepEqual(sanitizeSessionLayout({ sessionGroups: 'nope' }), {});
    assert.deepEqual(sanitizeSessionLayout(null), {});
  });
});
