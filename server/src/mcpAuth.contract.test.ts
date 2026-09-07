import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MCP_AUTH_METHODS,
  McpAuthPending,
  inspectInstalledSdk,
  mcpAuthSupport,
  normalizeAuthStart,
} from './mcpAuth.ts';

/**
 * The upgrade tripwire for `mcpAuthenticate` — an SDK method Lines calls without
 * a type declaration to hold it to.
 *
 * These tests exist to FAIL on an SDK bump, in either direction, because both
 * directions are actionable:
 *
 *  - methods gone from the runtime bundle → the feature is broken; the shim has
 *    to follow whatever replaced them.
 *  - methods present in the typings → the shim is obsolete; delete it and call
 *    the typed API, which the compiler can then check.
 *
 * If one of these goes red after `npm update`, that is the test doing its job.
 * Read the message, do the named thing; do not relax the assertion.
 */

test('the SDK runtime still exposes the OAuth methods this shim calls', () => {
  const { runtime } = inspectInstalledSdk();
  for (const name of MCP_AUTH_METHODS) {
    assert.equal(
      runtime[name],
      true,
      `Query.${name} is gone from the installed SDK bundle. MCP OAuth is broken until ` +
        `server/src/mcpAuth.ts follows the replacement API.`,
    );
  }
});

test('the SDK typings still do NOT declare them, so the shim is still needed', () => {
  const { declaredInTypings } = inspectInstalledSdk();
  assert.deepEqual(
    declaredInTypings,
    [],
    `The SDK now declares ${declaredInTypings.join(', ')} in sdk.d.ts. Delete the runtime ` +
      `probe in server/src/mcpAuth.ts and call the typed API directly, so the compiler ` +
      `checks these calls instead of a regex in this test.`,
  );
});

test('a Query missing a method degrades to unsupported instead of throwing', () => {
  const support = mcpAuthSupport({ mcpAuthenticate: () => {} });
  assert.equal(support.ok, false);
  assert.deepEqual(support.ok === false && support.missing, ['mcpSubmitOAuthCallbackUrl']);
});

test('a non-object Query is unsupported, not a crash', () => {
  for (const bad of [null, undefined, 42, 'nope']) {
    assert.equal(mcpAuthSupport(bad).ok, false, JSON.stringify(bad ?? null));
  }
});

test('a complete Query is supported', () => {
  const support = mcpAuthSupport({
    mcpAuthenticate: () => {},
    mcpSubmitOAuthCallbackUrl: () => {},
  });
  assert.equal(support.ok, true);
});

test('the observed Figma response normalizes', () => {
  // Recorded verbatim from a real handshake — the only record of this shape.
  const result = normalizeAuthStart({
    authUrl:
      'https://www.figma.com/oauth/mcp?response_type=code&client_id=Cm2Hbt&code_challenge=rT2h&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fmcp-oauth%2Fcallback&state=xtNJ&scope=mcp%3Aconnect',
    requiresUserAction: true,
    callbackExpected: true,
    redirectScheme: 'custom',
    state: 'xtNJ',
  });
  assert.ok('start' in result);
  assert.equal(result.start.state, 'xtNJ');
  assert.equal(result.start.callbackExpected, true);
});

test('a renamed url field is tolerated, a missing one is refused', () => {
  const renamed = normalizeAuthStart({ authorizationUrl: 'https://example.test/auth' });
  assert.ok('start' in renamed && renamed.start.authUrl === 'https://example.test/auth');
  for (const bad of [{}, null, { authUrl: '' }, { authUrl: 'not-a-url' }]) {
    assert.ok('error' in normalizeAuthStart(bad), JSON.stringify(bad));
  }
});

test('a non-web authorization URL is refused — the user is sent there', () => {
  assert.ok('error' in normalizeAuthStart({ authUrl: 'javascript:alert(1)' }));
  assert.ok('error' in normalizeAuthStart({ authUrl: 'file:///etc/passwd' }));
});

test('callbackExpected defaults to true when the field is absent', () => {
  const result = normalizeAuthStart({ authUrl: 'https://example.test/auth' });
  assert.ok('start' in result && result.start.callbackExpected === true);
});

test('a pending state is single-use', () => {
  const pending = new McpAuthPending();
  pending.start('state-abc', { userId: 'u', sessionId: 's', serverName: 'figma' });
  assert.deepEqual(pending.claim('state-abc')?.serverName, 'figma');
  // Replaying the same redirect must not re-authorize anything.
  assert.equal(pending.claim('state-abc'), null);
});

test('an unknown or wrong-length state is refused', () => {
  const pending = new McpAuthPending();
  pending.start('state-abc', { userId: 'u', sessionId: 's', serverName: 'figma' });
  assert.equal(pending.claim('state-abd'), null);
  assert.equal(pending.claim('state-abc-longer'), null);
  assert.equal(pending.claim(''), null);
  // The real one still works, so the misses did not consume it.
  assert.ok(pending.claim('state-abc'));
});

test('a dead session forgets its pending handshakes', () => {
  // The PKCE verifier lives in the CLI process leg 1 ran in, so a state whose
  // session is gone can never be completed and must not linger as replayable.
  const pending = new McpAuthPending();
  pending.start('s1-state', { userId: 'u', sessionId: 's1', serverName: 'figma' });
  pending.start('s2-state', { userId: 'u', sessionId: 's2', serverName: 'linear' });
  pending.forgetSession('s1');
  assert.equal(pending.claim('s1-state'), null);
  assert.ok(pending.claim('s2-state'));
});
