import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { GuardAllowEntry, GuardAllowlistBlob, GuardAllowlistReview } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { createStore } from './store.ts';

const blob = (entries: GuardAllowEntry[], updatedAt = 1): GuardAllowlistBlob => ({ entries, updatedAt });

const NPM: GuardAllowEntry = { tool: 'Bash', prefix: 'npm run' };
const GIT: GuardAllowEntry = { tool: 'Bash', prefix: 'git status' };
const CURL: GuardAllowEntry = { tool: 'Bash', prefix: 'curl' };

/** An allowlist over a throwaway store, seeded with `local`, with both callbacks recorded. */
function harness(local: GuardAllowEntry[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-guard-sync-'));
  fs.writeFileSync(path.join(root, 'guard-allowlist.json'), JSON.stringify(local));
  const store = createStore(root);
  const guard = new GuardAllowlist(store);
  const changes: GuardAllowEntry[][] = [];
  const reviews: (GuardAllowlistReview | null)[] = [];
  guard.onChange = (entries) => changes.push(entries);
  guard.onReview = (review) => reviews.push(review);
  return { root, guard, changes, reviews };
}

test('a divergent remote stages a review instead of applying it', () => {
  const h = harness([NPM]);
  h.guard.reviewRemote(blob([NPM, CURL]));
  assert.equal(h.guard.pendingReview, true);
  assert.deepEqual(h.guard.list(), [NPM]); // untouched
  assert.equal(h.reviews.length, 1);
  assert.equal(h.changes.length, 0); // nothing pushed from inside the applying window
});

test('the diff names what would start and stop being allowed', () => {
  const h = harness([NPM, GIT]);
  h.guard.reviewRemote(blob([NPM, CURL]));
  const review = h.guard.review()!;
  assert.deepEqual(review.added, [CURL]);
  assert.deepEqual(review.removed, [GIT]);
  assert.deepEqual(review.entries, [NPM, CURL]);
});

test('a set-equal remote in a different order is not a divergence, and clears one', () => {
  const h = harness([NPM, GIT]);
  h.guard.reviewRemote(blob([CURL]));
  assert.equal(h.guard.pendingReview, true);
  h.guard.reviewRemote(blob([GIT, NPM]));
  assert.equal(h.guard.pendingReview, false);
  assert.deepEqual(h.reviews.at(-1), null);
});

test('an absent remote row is not a divergence', () => {
  const h = harness([NPM]);
  h.guard.reviewRemote(blob([CURL]));
  h.guard.reviewRemote(null);
  assert.equal(h.guard.pendingReview, false);
  assert.deepEqual(h.reviews.at(-1), null);
});

test('invalid remote entries are dropped before they can reach the UI', () => {
  const h = harness([NPM]);
  h.guard.reviewRemote(blob([NPM, { tool: 'ExitPlanMode' }, { tool: 'Bash', prefix: '' }, CURL]));
  assert.deepEqual(h.guard.review()!.entries, [NPM, CURL]);
});

test('a remote of nothing but garbage produces no review', () => {
  const h = harness([NPM]);
  h.guard.reviewRemote(blob([NPM, { tool: '' }, { tool: 'AskUserQuestion' }]));
  assert.equal(h.guard.pendingReview, false);
});

test('accepting installs the reviewed list verbatim', () => {
  const h = harness([NPM]);
  h.guard.reviewRemote(blob([NPM, CURL]));
  assert.equal(h.guard.acceptReview(), true);
  assert.deepEqual(h.guard.list(), [NPM, CURL]);
  assert.deepEqual(h.changes.at(-1), [NPM, CURL]);
  assert.equal(h.guard.pendingReview, false);
});

test('rejecting keeps the local list but advances the timestamp so it wins the row', () => {
  const h = harness([NPM]);
  const before = h.guard.blob().updatedAt;
  h.guard.reviewRemote(blob([CURL]));
  assert.equal(h.guard.rejectReview(), true);
  assert.deepEqual(h.guard.list(), [NPM]);
  assert.ok(h.guard.blob().updatedAt >= before);
  assert.deepEqual(h.changes.at(-1), [NPM]); // fires, so the push is unblocked
  assert.equal(h.guard.pendingReview, false);
});

test('a rejection is remembered by remote content, not re-asked', () => {
  const h = harness([NPM]);
  h.guard.reviewRemote(blob([CURL]));
  h.guard.rejectReview();
  h.guard.reviewRemote(blob([CURL], 2));
  assert.equal(h.guard.pendingReview, false);
  // Different content: a genuinely new proposal still asks.
  h.guard.reviewRemote(blob([CURL, GIT], 3));
  assert.equal(h.guard.pendingReview, true);
});

test('a local edit while pending recomputes the diff rather than leaving a stale one', () => {
  const h = harness([NPM]);
  h.guard.reviewRemote(blob([CURL]));
  h.guard.add(GIT);
  const review = h.guard.review()!;
  assert.deepEqual(review.added, [CURL]);
  assert.deepEqual(review.removed, [NPM, GIT]);
  assert.deepEqual(h.reviews.at(-1), review);
});

test('a local edit that reaches the remote list resolves the review', () => {
  const h = harness([NPM]);
  h.guard.reviewRemote(blob([NPM, CURL]));
  h.guard.add(CURL);
  assert.equal(h.guard.pendingReview, false);
  assert.deepEqual(h.reviews.at(-1), null);
});

test('a pending review survives a restart, so hello can carry it', () => {
  const h = harness([NPM]);
  h.guard.reviewRemote(blob([NPM, CURL]));
  const reloaded = new GuardAllowlist(createStore(h.root));
  assert.equal(reloaded.pendingReview, true);
  assert.deepEqual(reloaded.review()!.added, [CURL]);
});
