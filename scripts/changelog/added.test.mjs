import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedReleases } from './added.mjs';

const release = (version, text = version) => ({ version, date: '2026-10-28', items: [text] });
const changelog = ({ web = [], desktop = [], desktopPending = [] } = {}) => ({
  web: web.map((v) => release(v)),
  desktop: desktop.map((v) => release(v)),
  desktopPending,
});
const keys = (added) => added.map(({ track, release }) => `${track}@${release.version}`);

test('the releases present at `to` and missing at `from`, per track', () => {
  const from = changelog({ web: ['0.1.2', '0.1.1'], desktop: ['0.2.0'] });
  const to = changelog({ web: ['0.1.4', '0.1.3', '0.1.2', '0.1.1'], desktop: ['0.2.1', '0.2.0'] });
  assert.deepEqual(keys(addedReleases(from, to)), ['web@0.1.4', 'web@0.1.3', 'desktop@0.2.1']);
});

test('the same version on the other track is still added', () => {
  const from = changelog({ web: ['0.2.0'] });
  const to = changelog({ web: ['0.2.0'], desktop: ['0.2.0'] });
  assert.deepEqual(keys(addedReleases(from, to)), ['desktop@0.2.0']);
});

test('nothing is added when the releases are the same', () => {
  const both = changelog({ web: ['0.1.1'], desktop: ['0.2.0'] });
  assert.deepEqual(addedReleases(both, both), []);
});

test('an edited existing release is not re-announced', () => {
  const from = { web: [release('0.1.1', 'Old text')], desktop: [], desktopPending: [] };
  const to = { web: [release('0.1.1', { text: 'Fixed text', image: 'web-0.1.1-x.png' })], desktop: [], desktopPending: [] };
  assert.deepEqual(addedReleases(from, to), []);
});

test('pending desktop items are never announced', () => {
  const from = changelog();
  const to = changelog({ desktopPending: ['Something coming'] });
  assert.deepEqual(addedReleases(from, to), []);
});

test('a file missing at `from` means every release is added', () => {
  const to = changelog({ web: ['0.1.2', '0.1.1'], desktop: ['0.2.0'] });
  assert.deepEqual(keys(addedReleases(null, to)), ['web@0.1.2', 'web@0.1.1', 'desktop@0.2.0']);
});

test('a file missing at `to` adds nothing', () => {
  assert.deepEqual(addedReleases(changelog({ web: ['0.1.1'] }), null), []);
});
