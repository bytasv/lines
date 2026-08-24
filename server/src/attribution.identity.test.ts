import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Actor, ShareProfile } from '@lines/shared';
import { resolveIdentity, type IdentityContext } from '../../web/src/lib/identityRule.ts';

/**
 * Who a prompt is attributed to.
 *
 * Mis-attribution is worse than no attribution: a prompt labelled with the wrong
 * person's name is a confident lie about who ran a command on somebody's machine.
 * Every case below is one I got wrong at least once.
 */

const ME = 'user_me';
const HOST = 'user_host';
const GUEST = 'user_guest';

const hostProfile: ShareProfile = {
  userId: HOST,
  email: 'host@example.com',
  name: 'Host Person',
  imageUrl: null,
};

/** On my own machine: no guest view, no host profile — I am the host. */
const asOwner: IdentityContext = {
  me: ME,
  myName: 'My Name',
  myImageUrl: 'https://img.clerk.com/me.png',
  host: null,
  isGuestView: false,
};
/** As a guest on HOST's machine. */
const asGuest: IdentityContext = {
  me: GUEST,
  myName: 'Guest Person',
  host: hostProfile,
  isGuestView: true,
};

const actor = (userId: string, name: string | null): Actor => ({ userId, name, imageUrl: null });

const knownGuest: ShareProfile = {
  userId: GUEST,
  email: 'guest@example.com',
  name: 'Guest Person',
  imageUrl: null,
};

describe('prompt attribution', () => {
  test('a recorded actor with no name resolves from what presence taught us', () => {
    // The case that made the owner see a raw id for a guest's prompt: the name is
    // captured at send time, so it is null whenever the profile was not cached
    // yet. Learning it later must fix every existing message, not just new ones.
    const ctx = { ...asOwner, profiles: { [GUEST]: knownGuest } };
    const who = resolveIdentity(ctx, GUEST, actor(GUEST, null));
    assert.equal(who.name, 'Guest Person');
  });

  test('the directory never overrides a name the record itself carries', () => {
    // The recorded actor is what was attested at the time; a later-learned profile
    // is a fallback, not a correction.
    const ctx = { ...asOwner, profiles: { [GUEST]: { ...knownGuest, name: 'Renamed' } } };
    const who = resolveIdentity(ctx, GUEST, actor(GUEST, 'Guest Person'));
    assert.equal(who.name, 'Guest Person');
  });

  test('an owner-authored prompt is attributed by its recorded id, not by the reader', () => {
    // Now that the owner's prompts carry an actor, a guest reading them resolves
    // the *recorded* author rather than inferring "no actor means the host" — so
    // the same message reads identically for everyone.
    const seen = { [HOST]: hostProfile };
    const asOwnerSeen = { ...asOwner, profiles: seen };
    const asGuestSeen = { ...asGuest, profiles: seen };
    const fromOwner = actor(HOST, null);
    assert.equal(resolveIdentity(asGuestSeen, HOST, fromOwner).name, 'Host Person');
    assert.equal(resolveIdentity(asOwnerSeen, HOST, fromOwner).name, 'Host Person');
  });

  test('my own prompt on my own machine is me, not "Unknown"', () => {
    // The bug that shipped: an absent actor never matched `me`, so it fell to the
    // last-resort branch and rendered "Unknown" with initials taken from that word.
    const who = resolveIdentity(asOwner, undefined, undefined);
    assert.equal(who.name, 'My Name');
    assert.equal(who.self, true);
    assert.equal(who.initials, 'MN');
  });

  test('my own avatar comes from Clerk, since the bridge cannot supply it', () => {
    // The bridge records an actor for the owner but leaves name and imageUrl null
    // (it has no Clerk lookup for itself), so without this your own messages show
    // initials while everyone else's show a picture.
    const withNulls = resolveIdentity(asOwner, ME, actor(ME, null));
    assert.equal(withNulls.imageUrl, 'https://img.clerk.com/me.png');
    assert.equal(withNulls.name, 'My Name');

    // Same for a historical row that carries no actor at all.
    assert.equal(resolveIdentity(asOwner, undefined, undefined).imageUrl, 'https://img.clerk.com/me.png');
  });

  test('somebody else never borrows my avatar', () => {
    const other = resolveIdentity(asOwner, GUEST, actor(GUEST, 'Guest Person'));
    assert.equal(other.imageUrl, null);
    assert.equal(other.self, false);
  });

  test('a historical prompt with no actor reads as the host', () => {
    // Rows predating sharing carry no actor. As a guest that means the host sent
    // it — a pure read-side reinterpretation, no migration.
    const who = resolveIdentity(asGuest, undefined, undefined);
    assert.equal(who.name, 'Host Person');
    assert.equal(who.self, false);
  });

  test('a guest sees their own prompt as themselves, not the host', () => {
    const who = resolveIdentity(asGuest, GUEST, actor(GUEST, 'Guest Person'));
    assert.equal(who.name, 'Guest Person');
    assert.equal(who.self, true);
  });

  test('the owner sees a guest prompt as the guest', () => {
    const who = resolveIdentity(asOwner, GUEST, actor(GUEST, 'Guest Person'));
    assert.equal(who.name, 'Guest Person');
    assert.equal(who.self, false);
  });

  test('an actor with no name still resolves to the host when it IS the host', () => {
    // The bridge sends no profile for its own owner, so a host-authored prompt can
    // arrive with a userId and a null name. It must not degrade to a raw id when
    // we hold the host's profile.
    const who = resolveIdentity(asGuest, HOST, actor(HOST, null));
    assert.equal(who.name, 'Host Person');
  });

  test('an unknown third party degrades to a stable id, never a blank', () => {
    const who = resolveIdentity(asOwner, 'user_3rdparty', actor('user_3rdparty', null));
    assert.ok(who.name.startsWith('3rdparty'), `got ${who.name}`);
    assert.ok(who.initials.length > 0);
    assert.equal(who.self, false);
  });

  test('two people are never coloured the same by accident of fallback', () => {
    // Colour is keyed on the resolved id, not the name — so an unnamed person and
    // a named one cannot collapse onto one colour just because both read "Unknown".
    const a = resolveIdentity(asOwner, 'user_aaa', actor('user_aaa', null));
    const b = resolveIdentity(asOwner, 'user_bbb', actor('user_bbb', null));
    assert.notEqual(a.userId, b.userId);
  });

  test('no-auth mode (no Clerk id) still renders something', () => {
    const local: IdentityContext = { me: null, myName: null, host: null, isGuestView: false };
    const who = resolveIdentity(local, undefined, undefined);
    assert.equal(who.name, 'Unknown');
    assert.equal(who.userId, 'unknown');
  });
});
