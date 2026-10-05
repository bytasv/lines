import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stampChangelog, stampFile } from './stamp-changelog.mjs';

const base = () => ({
  web: [{ version: '0.1.1', date: '2026-10-05', items: ['web'] }],
  desktop: [{ version: '0.2.42', date: '2026-10-01', items: ['older'] }],
  desktopPending: ['one', 'two'],
});

test('moves pending items into a new newest desktop release', () => {
  const after = stampChangelog(base(), '0.2.43', '2026-10-06');
  assert.deepEqual(after.desktop[0], { version: '0.2.43', date: '2026-10-06', items: ['one', 'two'] });
  assert.equal(after.desktop[1].version, '0.2.42');
  assert.deepEqual(after.desktopPending, []);
  assert.deepEqual(after.web, base().web);
});

test('is a no-op when nothing is pending', () => {
  const changelog = { ...base(), desktopPending: [] };
  assert.equal(stampChangelog(changelog, '0.2.43', '2026-10-06'), changelog);
  // Even for a version that exists: nothing would be stamped.
  assert.equal(stampChangelog(changelog, '0.2.42', '2026-10-06'), changelog);
});

test('refuses a version that already has a release', () => {
  assert.throws(() => stampChangelog(base(), '0.2.42', '2026-10-06'), /already has a desktop 0\.2\.42/);
});

test('stampFile writes only when something was pending', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-stamp-'));
  const file = path.join(repo, 'changelog.json');
  fs.writeFileSync(file, JSON.stringify(base()));
  assert.equal(stampFile('0.2.43', { repo, date: '2026-10-06' }), true);
  const written = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(written).desktop[0].version, '0.2.43');
  assert.equal(stampFile('0.2.44', { repo, date: '2026-10-06' }), false);
  assert.equal(fs.readFileSync(file, 'utf8'), written);
  fs.rmSync(repo, { recursive: true, force: true });
});
