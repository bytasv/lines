import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { compareVersions, nextSeen, releasesSince, type Changelog, type ChangelogRelease } from '@lines/shared';

const release = (version: string): ChangelogRelease => ({ version, date: '2026-10-05', items: [version] });
/** Newest first, as changelog.json keeps them. */
const RELEASES = ['0.5.0', '0.4.0', '0.3.1', '0.2.0', '0.1.1'].map(release);
const versions = (releases: ChangelogRelease[]) => releases.map((r) => r.version);

test('releasesSince takes what is above lastSeen, up to and including current', () => {
  assert.deepEqual(versions(releasesSince(RELEASES, '0.2.0', '0.4.0')), ['0.4.0', '0.3.1']);
  assert.deepEqual(versions(releasesSince(RELEASES, '0.4.0', '0.4.0')), []);
});

test('releasesSince spans every skipped version', () => {
  assert.deepEqual(versions(releasesSince(RELEASES, '0.1.0', '0.5.0')), ['0.5.0', '0.4.0', '0.3.1', '0.2.0', '0.1.1']);
});

test('releasesSince leaves out releases above the running version', () => {
  assert.deepEqual(versions(releasesSince(RELEASES, '0.3.1', '0.3.5')), []);
  assert.deepEqual(versions(releasesSince(RELEASES, '0.1.0', '0.2.0')), ['0.2.0', '0.1.1']);
});

test('nextSeen moves up to the running version', () => {
  assert.equal(nextSeen('0.2.0', '0.4.0', RELEASES), '0.4.0');
  assert.equal(nextSeen(null, '0.4.0', RELEASES), '0.4.0');
});

test('nextSeen never moves back for an older machine', () => {
  assert.equal(nextSeen('0.4.0', '0.2.0', RELEASES), '0.4.0');
});

test('nextSeen caps at the newest known release, so notes published later still show', () => {
  // The desktop app shipped 0.6.0 before the web app redeployed with its notes.
  assert.equal(nextSeen('0.4.0', '0.6.0', RELEASES), '0.5.0');
  assert.deepEqual(versions(releasesSince([release('0.6.0'), ...RELEASES], '0.5.0', '0.6.0')), ['0.6.0']);
  // With nothing known yet, there is nothing to cap at.
  assert.equal(nextSeen('0.4.0', '0.6.0', []), '0.6.0');
});

test('changelog.json is well-formed', () => {
  const file = path.resolve(import.meta.dirname, '..', '..', 'changelog.json');
  const changelog = JSON.parse(fs.readFileSync(file, 'utf8')) as Changelog;
  assert.ok(Array.isArray(changelog.desktopPending));
  for (const item of changelog.desktopPending) assert.ok(typeof item === 'string' && item.trim(), 'empty pending item');
  for (const track of ['web', 'desktop'] as const) {
    const releases = changelog[track];
    assert.ok(Array.isArray(releases), `${track} is not a list`);
    releases.forEach((r, i) => {
      assert.match(r.version, /^\d+\.\d+\.\d+$/, `${track} ${r.version}`);
      assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `${track} ${r.version} date`);
      assert.ok(!Number.isNaN(Date.parse(r.date)), `${track} ${r.version} date`);
      assert.ok(r.items.length > 0, `${track} ${r.version} has no items`);
      for (const item of r.items) {
        assert.ok(typeof item === 'string' && item.trim(), `${track} ${r.version} empty item`);
      }
      // Strictly descending, which also means unique.
      if (i > 0) {
        assert.ok(compareVersions(releases[i - 1].version, r.version) > 0, `${track} out of order at ${r.version}`);
      }
    });
  }
});
