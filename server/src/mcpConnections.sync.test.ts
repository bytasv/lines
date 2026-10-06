import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { McpConnection, McpConnectionsBlob, McpConnectionsReview } from '@lines/shared';
import { McpConnections } from './mcpConnections.ts';
import { createStore } from './store.ts';

/**
 * The cross-machine review lifecycle, case-for-case with
 * `autoGuard.sync.test.ts`: same rules, same reasons, different list.
 */

const conn = (name: string, url = `https://${name}.example/mcp`): McpConnection => ({
  id: name,
  name,
  transport: 'http',
  url,
  enabled: true,
});

const blob = (connections: McpConnection[], updatedAt = 1): McpConnectionsBlob => ({
  connections,
  updatedAt,
});

const FIGMA = conn('figma');
const LINEAR = conn('linear');
const SENTRY = conn('sentry');

function harness(local: McpConnection[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-mcp-sync-'));
  fs.writeFileSync(path.join(root, 'mcp-connections.json'), JSON.stringify(local));
  const store = createStore(root);
  const mcp = new McpConnections(store);
  const changes: McpConnection[][] = [];
  const reviews: (McpConnectionsReview | null)[] = [];
  mcp.onChange = (connections) => changes.push(connections);
  mcp.onReview = (review) => reviews.push(review);
  return { root, mcp, changes, reviews };
}

test('a divergent remote stages a review instead of applying it', () => {
  const h = harness([FIGMA]);
  h.mcp.reviewRemote(blob([FIGMA, SENTRY]));
  assert.equal(h.mcp.pendingReview, true);
  assert.deepEqual(h.mcp.list(), [FIGMA]); // untouched
  assert.equal(h.reviews.length, 1);
  assert.equal(h.changes.length, 0); // nothing pushed from inside the applying window
});

test('the diff names what would be added and removed', () => {
  const h = harness([FIGMA, LINEAR]);
  h.mcp.reviewRemote(blob([FIGMA, SENTRY]));
  const review = h.mcp.review()!;
  assert.deepEqual(review.added, [SENTRY]);
  assert.deepEqual(review.removed, [LINEAR]);
  assert.deepEqual(review.connections, [FIGMA, SENTRY]);
});

test('a set-equal remote in a different order is not a divergence, and clears one', () => {
  const h = harness([FIGMA, LINEAR]);
  h.mcp.reviewRemote(blob([SENTRY]));
  assert.equal(h.mcp.pendingReview, true);
  h.mcp.reviewRemote(blob([LINEAR, FIGMA]));
  assert.equal(h.mcp.pendingReview, false);
  assert.deepEqual(h.reviews.at(-1), null);
});

test('a changed field on the same connection is a divergence', () => {
  // Ids travel with the row, so an edit elsewhere is a remove plus an add —
  // which is exactly what the user has to be shown.
  const h = harness([FIGMA]);
  h.mcp.reviewRemote(blob([conn('figma', 'https://figma.example/other')]));
  assert.equal(h.mcp.pendingReview, true);
  assert.equal(h.mcp.review()!.added.length, 1);
  assert.equal(h.mcp.review()!.removed.length, 1);
});

test('an absent remote row is not a divergence', () => {
  const h = harness([FIGMA]);
  h.mcp.reviewRemote(blob([SENTRY]));
  h.mcp.reviewRemote(null);
  assert.equal(h.mcp.pendingReview, false);
  assert.deepEqual(h.reviews.at(-1), null);
});

test('invalid remote rows are dropped before they can reach the UI', () => {
  const h = harness([FIGMA]);
  h.mcp.reviewRemote(
    blob([
      FIGMA,
      { ...conn('lines'), name: 'lines' }, // reserved — must never be offered
      { ...conn('broken'), url: 'not-a-url' },
      SENTRY,
    ]),
  );
  assert.deepEqual(h.mcp.review()!.connections, [FIGMA, SENTRY]);
});

test('a remote of nothing but garbage produces no review', () => {
  const h = harness([FIGMA]);
  h.mcp.reviewRemote(blob([FIGMA, { ...conn('lines'), name: 'lines' }]));
  assert.equal(h.mcp.pendingReview, false);
});

test('accepting installs the reviewed list verbatim', () => {
  const h = harness([FIGMA]);
  h.mcp.reviewRemote(blob([FIGMA, SENTRY]));
  assert.equal(h.mcp.acceptReview(), true);
  assert.deepEqual(h.mcp.list(), [FIGMA, SENTRY]);
  assert.deepEqual(h.changes.at(-1), [FIGMA, SENTRY]);
  assert.equal(h.mcp.pendingReview, false);
});

test('an accepted connection arrives with no secret, so it needs one entered here', () => {
  const h = harness();
  h.mcp.reviewRemote(blob([{ ...FIGMA, headerKeys: ['Authorization'] }]));
  h.mcp.acceptReview();
  assert.deepEqual(h.mcp.secretKeys(FIGMA.id), []);
  assert.equal('headers' in (h.mcp.serverConfigs().figma as object), false);
});

test('rejecting keeps the local list but advances the timestamp so it wins the row', () => {
  const h = harness([FIGMA]);
  const before = h.mcp.blob().updatedAt;
  h.mcp.reviewRemote(blob([SENTRY]));
  assert.equal(h.mcp.rejectReview(), true);
  assert.deepEqual(h.mcp.list(), [FIGMA]);
  assert.ok(h.mcp.blob().updatedAt >= before);
  assert.deepEqual(h.changes.at(-1), [FIGMA]); // fires, so the push is unblocked
  assert.equal(h.mcp.pendingReview, false);
});

test('a rejection is remembered by remote content, not re-asked', () => {
  const h = harness([FIGMA]);
  h.mcp.reviewRemote(blob([SENTRY]));
  h.mcp.rejectReview();
  h.mcp.reviewRemote(blob([SENTRY], 2));
  assert.equal(h.mcp.pendingReview, false);
  // Different content: a genuinely new proposal still asks.
  h.mcp.reviewRemote(blob([SENTRY, LINEAR], 3));
  assert.equal(h.mcp.pendingReview, true);
});

test('a local edit while pending recomputes the diff rather than leaving a stale one', () => {
  const h = harness([FIGMA]);
  h.mcp.reviewRemote(blob([SENTRY]));
  h.mcp.add(LINEAR);
  const review = h.mcp.review()!;
  assert.deepEqual(review.added, [SENTRY]);
  assert.deepEqual(
    review.removed.map((c) => c.name),
    ['figma', 'linear'],
  );
  assert.deepEqual(h.reviews.at(-1), review);
});

test('a local edit that reaches the remote list resolves the review', () => {
  const h = harness([FIGMA]);
  h.mcp.reviewRemote(blob([FIGMA, SENTRY]));
  h.mcp.add(SENTRY);
  assert.equal(h.mcp.pendingReview, false);
  assert.deepEqual(h.reviews.at(-1), null);
});

test('a pending review survives a restart, so hello can carry it', () => {
  const h = harness([FIGMA]);
  h.mcp.reviewRemote(blob([FIGMA, SENTRY]));
  const reloaded = new McpConnections(createStore(h.root));
  assert.equal(reloaded.pendingReview, true);
  assert.deepEqual(reloaded.review()!.added, [SENTRY]);
});

/**
 * Env values. They stay on the machine that has them, so a remote row never
 * carries one — and a row written before names-only sync, which does, must not
 * be able to hand one over.
 */

const STDIO = { name: 'local', transport: 'stdio', command: 'npx' } as const;

/** A stdio row the way a bridge that predates names-only sync pushed it. */
const legacyRow = (connection: McpConnection, env: Record<string, string>) =>
  ({ ...connection, envKeys: undefined, env }) as unknown as McpConnection;

test('a connection that differs only by its env values is not a divergence', () => {
  // This machine holds the value and the cloud row never does; comparing values
  // would re-open the review on every pull.
  const h = harness();
  const added = h.mcp.add({ ...STDIO, env: { API_KEY: 'sk-mine' } });
  assert.ok(added.ok);
  h.mcp.reviewRemote(blob([added.connection]));
  assert.equal(h.mcp.pendingReview, false);
  // Nor when the remote row still carries a value of its own.
  h.mcp.reviewRemote(blob([legacyRow(added.connection, { API_KEY: 'sk-theirs' })]));
  assert.equal(h.mcp.pendingReview, false);
});

test('accepting takes no env value from the remote and keeps this machine\'s own', () => {
  const h = harness();
  const added = h.mcp.add({ ...STDIO, env: { API_KEY: 'sk-mine' } });
  assert.ok(added.ok);
  const planted = legacyRow(
    { id: 'other', name: 'other', transport: 'stdio', command: 'uvx', enabled: true },
    { TOKEN: 'sk-planted' },
  );
  h.mcp.reviewRemote(blob([legacyRow(added.connection, { API_KEY: 'sk-theirs' }), planted]));
  // Not even as far as the modal.
  assert.equal(JSON.stringify(h.mcp.review()).includes('sk-'), false);
  assert.equal(h.mcp.acceptReview(), true);
  const configs = h.mcp.serverConfigs() as Record<string, { env?: Record<string, string> }>;
  assert.deepEqual(configs.local.env, { API_KEY: 'sk-mine' });
  // The name arrives, so this machine knows what to ask for; the value does not.
  assert.deepEqual(h.mcp.list().find((c) => c.id === 'other')?.envKeys, ['TOKEN']);
  assert.equal(configs.other.env, undefined);
  assert.equal(JSON.stringify(h.mcp.blob()).includes('sk-'), false);
});

test('held marks stay local: a remote row cannot claim one, and a review carries none', () => {
  const h = harness();
  const added = h.mcp.add({ ...STDIO, env: { API_KEY: 'sk-mine' } });
  assert.ok(added.ok);
  // A remote row claiming values for names this machine has none for, beside a
  // change that stages a review.
  const claiming = { ...added.connection, envKeys: ['API_KEY', 'OTHER'], envValuesHeld: ['API_KEY', 'OTHER'] };
  h.mcp.reviewRemote(blob([claiming, SENTRY]));
  // The modal diffs synced content — names — and nothing about either machine.
  assert.equal(JSON.stringify(h.mcp.review()).includes('envValuesHeld'), false);
  assert.equal(h.mcp.acceptReview(), true);
  // Marked from this machine's own file, not from what the remote said.
  assert.deepEqual(h.mcp.list().find((c) => c.name === 'local')?.envValuesHeld, ['API_KEY']);
  assert.equal(JSON.stringify(h.mcp.blob()).includes('envValuesHeld'), false);
});

test('a review an older build staged loses its env values on load', () => {
  // Before names-only sync, a pulled row was staged with its values in it, and
  // they stayed on disk for as long as the review — or its rejection — did.
  const h = harness([FIGMA]);
  const local = { id: 'local', ...STDIO, enabled: true };
  fs.writeFileSync(
    path.join(h.root, 'mcp-connections-sync.json'),
    JSON.stringify({
      updatedAt: 1,
      pending: {
        connections: [FIGMA, { ...local, env: { API_KEY: 'sk-staged' } }],
        remoteUpdatedAt: 2,
        detectedAt: 3,
      },
      rejected: { connections: [{ ...local, env: { API_KEY: 'sk-rejected' } }], rejectedAt: 4 },
    }),
  );
  const reloaded = new McpConnections(createStore(h.root));
  const onDisk = fs.readFileSync(path.join(h.root, 'mcp-connections-sync.json'), 'utf8');
  assert.equal(onDisk.includes('sk-staged'), false);
  assert.equal(onDisk.includes('sk-rejected'), false);
  const review = reloaded.review()!;
  assert.deepEqual(review.added.map((c) => c.envKeys), [['API_KEY']]);
  assert.equal(review.detectedAt, 3); // still the same review, so a dismissal still holds
});

test('a staged review that differed only by env values is dropped on load', () => {
  const local = { id: 'local', ...STDIO, envKeys: ['API_KEY'], enabled: true };
  const h = harness([local]);
  fs.writeFileSync(
    path.join(h.root, 'mcp-connections-sync.json'),
    JSON.stringify({
      updatedAt: 1,
      pending: {
        connections: [legacyRow(local, { API_KEY: 'sk-theirs' })],
        remoteUpdatedAt: 2,
        detectedAt: 3,
      },
      rejected: null,
    }),
  );
  assert.equal(new McpConnections(createStore(h.root)).pendingReview, false);
});
