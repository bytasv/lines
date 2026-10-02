import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MESSAGE_AUTHZ,
  OWNER_ACCESS,
  authorizeMessage,
  capsForPreset,
  parseShareCaps,
  type ClientMessage,
  type ShareCaps,
  type SocketAccess,
} from '@lines/shared';

/**
 * The default-deny gate every client message passes through.
 *
 * The exhaustive `Record<ClientMessage['type'], …>` makes an unclassified message
 * a *compile* error, so this file covers what the compiler cannot: that the
 * classifications are the intended ones, and that a guest cannot reach past their
 * grant. The cases worth caring about are all negative.
 */

/** A grant with exactly the capabilities named — everything else denied. */
const access = (caps: Partial<ShareCaps>, over: Partial<Omit<SocketAccess, 'caps'>> = {}): SocketAccess => ({
  scope: 'machine',
  ...over,
  caps: parseShareCaps(caps),
});

const guest = (preset: 'view' | 'prompt' | 'collaborator', over: Partial<SocketAccess> = {}) => ({
  scope: 'machine' as const,
  caps: capsForPreset(preset, over.scope === 'session' ? 'session' : 'machine'),
  ...over,
});

/** Minimal well-formed messages, enough for the gate (which reads type + sessionId). */
const msg = (type: ClientMessage['type'], sessionId = 's1') =>
  ({ type, sessionId }) as unknown as ClientMessage;

describe('MESSAGE_AUTHZ', () => {
  test('the owner may send every classified message', () => {
    for (const type of Object.keys(MESSAGE_AUTHZ) as ClientMessage['type'][]) {
      const verdict = authorizeMessage(msg(type), OWNER_ACCESS);
      assert.equal(verdict.ok, true, `owner must be allowed to send ${type}`);
    }
  });

  test('a guest with no capabilities may only watch and heartbeat', () => {
    // Two classes survive an empty cap set, and only two: socket-level traffic,
    // and the session reads classified `cap: null` — a grant with no capabilities
    // is still a grant, and seeing the session is what it is for. Everything else
    // must deny, which is the default-deny property.
    const bare = access({});
    for (const type of Object.keys(MESSAGE_AUTHZ) as ClientMessage['type'][]) {
      const rule = MESSAGE_AUTHZ[type];
      const allowedWithNoCaps =
        rule.needs === 'connection' || (rule.needs === 'session' && rule.cap === null);
      assert.equal(
        authorizeMessage(msg(type), bare).ok,
        allowedWithNoCaps,
        `${type} with no capabilities should be ${allowedWithNoCaps ? 'allowed' : 'denied'}`,
      );
    }
  });

  test('the never-grantable set stays never-grantable, even for a collaborator', () => {
    // Settings, the guard allowlist, project and worktree management, the Claude
    // account, the step/recipe library, deleting a session, installing an update.
    const ownerOnly = (Object.keys(MESSAGE_AUTHZ) as ClientMessage['type'][]).filter(
      (t) => MESSAGE_AUTHZ[t].needs === 'owner',
    );
    // A canary: if someone reclassifies one of these away from owner-only, the
    // count changes and this test says so out loud.
    assert.ok(ownerOnly.includes('saveSettings'));
    assert.ok(ownerOnly.includes('deleteSession'));
    assert.ok(ownerOnly.includes('addGuardAllow'));
    // MCP connections run third-party code inside every session on the machine,
    // and their status report names the host's servers. Both of the last two also
    // reach further than they read: authorizing signs the *host* in to a
    // third-party account, and a status read may bring a session's query (and so
    // a CLI child) up on the host's machine.
    assert.ok(ownerOnly.includes('addMcpConnection'));
    assert.ok(ownerOnly.includes('updateMcpConnection'));
    assert.ok(ownerOnly.includes('removeMcpConnection'));
    assert.ok(ownerOnly.includes('reviewMcpConnections'));
    assert.ok(ownerOnly.includes('authorizeMcpConnection'));
    assert.ok(ownerOnly.includes('mcpServerStatus'));
    assert.ok(ownerOnly.includes('authLogout'));
    assert.ok(ownerOnly.includes('installUpdate'));
    assert.ok(ownerOnly.includes('pickFolder'));
    // Push covers every session on the machine, and the bridge POSTs to the
    // endpoint the message supplies.
    assert.ok(ownerOnly.includes('registerPush'));
    assert.ok(ownerOnly.includes('unregisterPush'));

    for (const scope of ['machine', 'session'] as const) {
      for (const type of ownerOnly) {
        const verdict = authorizeMessage(msg(type), guest('collaborator', { scope, sessionIds: ['s1'] }));
        assert.equal(verdict.ok, false, `${type} must stay owner-only at ${scope} scope`);
      }
    }
  });

  test('no preset can change the permission mode', () => {
    // It is the guard around every other capability, so it is the one control a
    // Collaborator still cannot touch.
    for (const preset of ['view', 'prompt', 'collaborator'] as const) {
      assert.equal(authorizeMessage(msg('setPermissionMode'), guest(preset)).ok, false, preset);
    }
  });

  test('view only may watch but not act', () => {
    const viewer = guest('view');
    assert.equal(authorizeMessage(msg('loadTranscript'), viewer).ok, true);
    assert.equal(authorizeMessage(msg('ackSession'), viewer).ok, true);
    assert.equal(authorizeMessage(msg('prompt'), viewer).ok, false);
    assert.equal(authorizeMessage(msg('interrupt'), viewer).ok, false);
    assert.equal(authorizeMessage(msg('permissionResponse'), viewer).ok, false);
  });

  test('can prompt may prompt, but not stop, retry or approve', () => {
    const prompter = guest('prompt');
    assert.equal(authorizeMessage(msg('prompt'), prompter).ok, true);
    assert.equal(authorizeMessage(msg('interrupt'), prompter).ok, false);
    assert.equal(authorizeMessage(msg('retryTurn'), prompter).ok, false);
    assert.equal(authorizeMessage(msg('permissionResponse'), prompter).ok, false);
    assert.equal(authorizeMessage(msg('setModel'), prompter).ok, false);
    // Effort rides the setModel cap rather than one of its own, so it has to be
    // denied in exactly the same places.
    assert.equal(authorizeMessage(msg('setReasoningEffort'), prompter).ok, false);
    // Answering a routing suggestion switches model and effort, so it rides the
    // same cap — and so does pausing routing.
    assert.equal(authorizeMessage(msg('routingChoice'), prompter).ok, false);
    assert.equal(authorizeMessage(msg('setRoutingPaused'), prompter).ok, false);
    // Per-run step overrides are the same model/effort choice, made ahead.
    assert.equal(authorizeMessage(msg('setWorkflowStepOverrides'), prompter).ok, false);
  });

  test('setWorkflowStepOverrides is session-scoped on the setModel cap', () => {
    assert.deepEqual(MESSAGE_AUTHZ.setWorkflowStepOverrides, { needs: 'session', cap: 'setModel' });
    const scoped = guest('collaborator', { scope: 'session', sessionIds: ['s1'] });
    assert.equal(authorizeMessage(msg('setWorkflowStepOverrides', 's1'), scoped).ok, true);
    assert.equal(authorizeMessage(msg('setWorkflowStepOverrides', 's2'), scoped).ok, false);
  });

  test('editQueued follows prompt, not interrupt', () => {
    // Named on purpose: editQueued sits at `prompt` while cancelQueued sits at
    // `interrupt`, which reads as an inconsistency worth "tidying up". It is not.
    // The Can prompt preset is the one whose prompts land paused for approval, so
    // moving this to `interrupt` would deny a guest the fix of their own pending
    // prompt — the main reason the message exists.
    assert.equal(authorizeMessage(msg('editQueued'), guest('prompt')).ok, true);
    assert.equal(authorizeMessage(msg('editQueued'), guest('collaborator')).ok, true);
    assert.equal(authorizeMessage(msg('editQueued'), guest('view')).ok, false);
  });

  test('interjectQueued is a prompt, and its owner gate is not in this table', () => {
    // The split a future reader will get wrong. This table says "may you deliver a
    // prompt at all" — View only cannot, Can prompt can. What it *cannot* express
    // is "prompt but not `promptNeedsApproval`": a Can prompt guest passes here and
    // is then refused by SessionManager.interjectQueued's first line, so they can
    // never release their own held prompt onto the owner's machine. That refusal is
    // asserted in sessions.queue.test.ts, not here.
    assert.equal(authorizeMessage(msg('interjectQueued'), guest('view')).ok, false);
    assert.equal(authorizeMessage(msg('interjectQueued'), guest('prompt')).ok, true);
  });

  test('a collaborator may drive a turn but still not delete the session', () => {
    const collab = guest('collaborator');
    assert.equal(authorizeMessage(msg('prompt'), collab).ok, true);
    assert.equal(authorizeMessage(msg('interrupt'), collab).ok, true);
    assert.equal(authorizeMessage(msg('permissionResponse'), collab).ok, true);
    assert.equal(authorizeMessage(msg('workflowApprove'), collab).ok, true);
    assert.equal(authorizeMessage(msg('setModel'), collab).ok, true);
    assert.equal(authorizeMessage(msg('setReasoningEffort'), collab).ok, true);
    assert.equal(authorizeMessage(msg('setWorkflowStepOverrides'), collab).ok, true);
    assert.equal(authorizeMessage(msg('routingChoice'), collab).ok, true);
    assert.equal(authorizeMessage(msg('deleteSession'), collab).ok, false);
  });

  test('a session-scoped guest cannot reach a sibling session', () => {
    // The single most important negative case: holding a share on one session
    // must not be holding one on everything else on that machine.
    const scoped = guest('collaborator', { scope: 'session', sessionIds: ['s1'] });
    assert.equal(authorizeMessage(msg('prompt', 's1'), scoped).ok, true);
    assert.equal(authorizeMessage(msg('prompt', 's2'), scoped).ok, false);
    assert.equal(authorizeMessage(msg('loadTranscript', 's2'), scoped).ok, false);
    assert.equal(authorizeMessage(msg('interrupt', 's2'), scoped).ok, false);
  });

  test('a session-scoped guest with an empty list reaches nothing', () => {
    const empty = guest('collaborator', { scope: 'session', sessionIds: [] });
    assert.equal(authorizeMessage(msg('prompt', 's1'), empty).ok, false);
  });

  test('a session-scoped grant cannot create sessions', () => {
    // createSessions is machine-scope only: a session share has no folder to
    // create in, and creating one would escape the grant entirely.
    const scoped = guest('collaborator', { scope: 'session', sessionIds: ['s1'] });
    assert.equal(authorizeMessage(msg('createSession'), scoped).ok, false);
    const machine = guest('collaborator', { scope: 'machine' });
    assert.equal(authorizeMessage(msg('createSession'), machine).ok, true);
  });

  test('a session-scoped message with no sessionId is denied, not defaulted', () => {
    const scoped = guest('collaborator', { scope: 'session', sessionIds: ['s1'] });
    assert.equal(authorizeMessage({ type: 'prompt' } as ClientMessage, scoped).ok, false);
  });

  test('a denial always carries a reason a person can act on', () => {
    for (const type of Object.keys(MESSAGE_AUTHZ) as ClientMessage['type'][]) {
      const verdict = authorizeMessage(msg(type), access({}));
      if (!verdict.ok) assert.ok(verdict.reason.length > 10, `${type} needs a real reason`);
    }
  });
});
