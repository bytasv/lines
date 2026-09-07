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
