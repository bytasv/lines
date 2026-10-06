import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { capsForPreset } from '@lines/shared';
import {
  GRANT_CLAIM_TTL_MS,
  GRANT_RECONCILE_GRACE_MS,
  combineGrants,
  reconcileGuestGrants,
  guestAccessFor,
  mintGuestGrant,
  redeemGuestGrant,
  revokeGuestGrants,
  updateGuestGrants,
  type GuestGrantFile,
  type GuestGrantStore,
} from './guestGrants.ts';

/**
 * The grants a host's bridge minted itself — what a guest is now admitted on,
 * instead of the relay's word. The cases worth pinning are all a stranger, or a
 * relay, getting more than the host gave.
 */

/** An in-memory store, so nothing touches ~/.lines-app. */
function memoryStore(): GuestGrantStore & { file: () => GuestGrantFile } {
  let grants: GuestGrantFile = {};
  return {
    load: () => structuredClone(grants),
    save: (next) => {
      grants = structuredClone(next);
    },
    file: () => grants,
  };
}

const sessionCaps = capsForPreset('collaborator', 'session');
const machineCaps = capsForPreset('full', 'machine');

describe('minting and redeeming', () => {
  test('the token is never stored, only its hash', () => {
    const store = memoryStore();
    const { id, token } = mintGuestGrant({ hostUserId: 'u-host', scope: 'session', sessionIds: ['s1'], caps: sessionCaps }, store);
    assert.ok(token.length >= 40, '256 bits of token');
    assert.equal(JSON.stringify(store.file()).includes(token), false);
    assert.equal(store.file()[id]?.guestUserId, null, 'unbound until someone redeems it');
  });

  test('the first account to redeem it owns it; a forwarded link stops there', () => {
    const store = memoryStore();
    const { token } = mintGuestGrant({ hostUserId: 'u-host', scope: 'machine', caps: machineCaps }, store);
    const first = redeemGuestGrant(token, 'u-guest', store);
    assert.equal(first?.guestUserId, 'u-guest');
    assert.equal(redeemGuestGrant(token, 'u-guest', store)?.hostUserId, 'u-host', 'the same guest again is fine');
    assert.equal(redeemGuestGrant(token, 'u-stranger', store), null);
  });

  test('a token nobody minted redeems nothing', () => {
    const store = memoryStore();
    mintGuestGrant({ hostUserId: 'u-host', scope: 'machine', caps: machineCaps }, store);
    assert.equal(redeemGuestGrant('made-up', 'u-guest', store), null);
    assert.equal(redeemGuestGrant('', 'u-guest', store), null);
  });

  test('an unredeemed link expires with its invite; a redeemed one does not', () => {
    const store = memoryStore();
    const t0 = 1_000_000;
    const stale = mintGuestGrant({ hostUserId: 'u-host', scope: 'machine', caps: machineCaps }, store, t0);
    const used = mintGuestGrant({ hostUserId: 'u-host', scope: 'machine', caps: machineCaps }, store, t0);
    assert.ok(redeemGuestGrant(used.token, 'u-guest', store, t0 + 1));
    const later = t0 + GRANT_CLAIM_TTL_MS + 1;
    assert.equal(redeemGuestGrant(stale.token, 'u-guest', store, later), null);
    assert.ok(redeemGuestGrant(used.token, 'u-guest', store, later));
  });
});

describe('managing a host’s grants', () => {
  test('revoking ends exactly the matching grants of that host', () => {
    const store = memoryStore();
    const a = mintGuestGrant({ hostUserId: 'u-host', scope: 'session', sessionIds: ['s1'], caps: sessionCaps }, store);
    const b = mintGuestGrant({ hostUserId: 'u-host', scope: 'machine', caps: machineCaps }, store);
    const other = mintGuestGrant({ hostUserId: 'u-other-host', scope: 'machine', caps: machineCaps }, store);
    redeemGuestGrant(a.token, 'u-guest', store);
    redeemGuestGrant(b.token, 'u-guest', store);
    redeemGuestGrant(other.token, 'u-guest', store);

    // The machine grant only.
    assert.deepEqual(revokeGuestGrants('u-host', { guestUserId: 'u-guest', sessionId: null }, store).map((g) => g.id), [b.id]);
    assert.equal(redeemGuestGrant(b.token, 'u-guest', store), null);
    assert.ok(redeemGuestGrant(a.token, 'u-guest', store), 'the session grant survives');
    // Another host's grant is never touched by this host's revoke.
    assert.deepEqual(revokeGuestGrants('u-host', { guestUserId: 'u-guest' }, store).map((g) => g.id), [a.id]);
    assert.ok(redeemGuestGrant(other.token, 'u-guest', store));
  });

  test('a match that names nobody revokes nothing', () => {
    const store = memoryStore();
    mintGuestGrant({ hostUserId: 'u-host', scope: 'machine', caps: machineCaps }, store);
    assert.deepEqual(revokeGuestGrants('u-host', {}, store), []);
    assert.deepEqual(revokeGuestGrants('u-host', { sessionId: null }, store), []);
  });

  test('an unredeemed grant is revoked by its id', () => {
    const store = memoryStore();
    const { id, token } = mintGuestGrant({ hostUserId: 'u-host', scope: 'machine', caps: machineCaps }, store);
    assert.equal(revokeGuestGrants('u-host', { grantId: id }, store).length, 1);
    assert.equal(redeemGuestGrant(token, 'u-guest', store), null);
  });

  test('a preset change moves the ceiling', () => {
    const store = memoryStore();
    const { token } = mintGuestGrant({ hostUserId: 'u-host', scope: 'session', sessionIds: ['s1'], caps: capsForPreset('view', 'session') }, store);
    redeemGuestGrant(token, 'u-guest', store);
    assert.equal(updateGuestGrants('u-host', { guestUserId: 'u-guest', sessionId: 's1' }, sessionCaps, store).length, 1);
    assert.equal(redeemGuestGrant(token, 'u-guest', store)?.caps.prompt, true);
  });
});

describe('guestAccessFor: the relay can take away, never give', () => {
  const store = memoryStore();
  const viewSession = (() => {
    const { token } = mintGuestGrant({ hostUserId: 'u-host', scope: 'session', sessionIds: ['s1'], caps: capsForPreset('view', 'session') }, store);
    return redeemGuestGrant(token, 'u-guest', store)!;
  })();
  const fullMachine = (() => {
    const { token } = mintGuestGrant({ hostUserId: 'u-host', scope: 'machine', caps: machineCaps }, store);
    return redeemGuestGrant(token, 'u-guest', store)!;
  })();

  test('a relay attesting a machine-wide full grant still gets only the view-only session', () => {
    const access = guestAccessFor(viewSession, { scope: 'machine', caps: { ...machineCaps } });
    assert.equal(access?.scope, 'session');
    assert.deepEqual(access?.sessionIds, ['s1']);
    assert.equal(access?.caps.prompt, false);
    assert.equal(access?.caps.approvePermissions, false);
    assert.equal(access?.caps.createSessions, false);
  });

  test('a narrowed share in storage narrows here too', () => {
    const access = guestAccessFor(fullMachine, { scope: 'machine', caps: { ...capsForPreset('view', 'machine') } });
    assert.equal(access?.caps.prompt, false);
    assert.equal(access?.caps.readFiles, true);
  });

  test('approval-before-prompting holds when either side asks for it', () => {
    const access = guestAccessFor(fullMachine, { scope: 'machine', caps: { ...capsForPreset('prompt', 'machine') } });
    assert.equal(access?.caps.promptNeedsApproval, true);
  });

  test('a session attestation narrows a machine grant to those sessions', () => {
    const access = guestAccessFor(fullMachine, { scope: 'session', caps: { ...machineCaps }, sessionIds: ['s9'] });
    assert.equal(access?.scope, 'session');
    assert.deepEqual(access?.sessionIds, ['s9']);
    assert.equal(access?.caps.createSessions, false);
  });

  test('sessions named by only one side are not reachable; none in common is no access', () => {
    assert.equal(guestAccessFor(viewSession, { scope: 'session', caps: { readFiles: true }, sessionIds: ['s2'] }), null);
  });

  test('an owner-shaped or unknown attestation is no access at all', () => {
    assert.equal(guestAccessFor(fullMachine, { scope: 'owner', caps: { ...machineCaps } }), null);
    assert.equal(guestAccessFor(fullMachine, { scope: 'root' }), null);
  });
});

describe('combineGrants: a guest with more than one share on a machine', () => {
  const store = memoryStore();
  const redeemed = (scope: 'machine' | 'session', preset: 'view' | 'prompt' | 'collaborator', sessionIds?: string[]) => {
    const { token } = mintGuestGrant(
      { hostUserId: 'u-host', scope, sessionIds, caps: capsForPreset(preset, scope) },
      store,
    );
    return redeemGuestGrant(token, 'u-guest', store)!;
  };

  test('two session shares reach both sessions', () => {
    const both = combineGrants([redeemed('session', 'view', ['s1']), redeemed('session', 'collaborator', ['s2'])]);
    assert.equal(both?.scope, 'session');
    assert.deepEqual(both?.sessionIds, ['s1', 's2']);
    assert.equal(both?.caps.prompt, true);
  });

  test('a machine share among them makes it machine-wide', () => {
    assert.equal(combineGrants([redeemed('session', 'view', ['s1']), redeemed('machine', 'view')])?.scope, 'machine');
  });

  test('approval-before-prompting holds only if every grant asks for it', () => {
    assert.equal(combineGrants([redeemed('session', 'prompt', ['s1'])])?.caps.promptNeedsApproval, true);
    assert.equal(
      combineGrants([redeemed('session', 'prompt', ['s1']), redeemed('session', 'collaborator', ['s2'])])?.caps
        .promptNeedsApproval,
      false,
    );
  });

  test('none is nothing', () => {
    assert.equal(combineGrants([]), null);
  });
});

describe('reconcileGuestGrants: storage can take a grant away, never give one', () => {
  test('a grant whose share is gone from storage is dropped once past the grace period', () => {
    const store = memoryStore();
    const t0 = 5_000_000;
    const kept = mintGuestGrant({ hostUserId: 'u-host', scope: 'machine', caps: machineCaps }, store, t0);
    const gone = mintGuestGrant({ hostUserId: 'u-host', scope: 'machine', caps: machineCaps }, store, t0);
    redeemGuestGrant(gone.token, 'u-guest', store, t0);
    const later = t0 + GRANT_RECONCILE_GRACE_MS + 1;
    const removed = reconcileGuestGrants('u-host', new Set([kept.id]), store, later);
    assert.deepEqual(removed.map((g) => g.id), [gone.id]);
    assert.equal(redeemGuestGrant(gone.token, 'u-guest', store, later), null, 'revoked while offline, ended here too');
    assert.ok(redeemGuestGrant(kept.token, 'u-guest', store, later));
  });

  test('a grant minted moments ago survives: its invite may not be in storage yet', () => {
    const store = memoryStore();
    const t0 = 5_000_000;
    const fresh = mintGuestGrant({ hostUserId: 'u-host', scope: 'machine', caps: machineCaps }, store, t0);
    assert.deepEqual(reconcileGuestGrants('u-host', new Set(), store, t0 + 1000), []);
    assert.ok(redeemGuestGrant(fresh.token, 'u-guest', store, t0 + 1000));
  });

  test('another host’s grants are never touched', () => {
    const store = memoryStore();
    const t0 = 5_000_000;
    const other = mintGuestGrant({ hostUserId: 'u-other', scope: 'machine', caps: machineCaps }, store, t0);
    assert.deepEqual(reconcileGuestGrants('u-host', new Set(), store, t0 + GRANT_RECONCILE_GRACE_MS + 1), []);
    assert.ok(redeemGuestGrant(other.token, 'u-guest', store, t0 + GRANT_RECONCILE_GRACE_MS + 1));
  });
});
