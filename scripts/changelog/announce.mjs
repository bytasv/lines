#!/usr/bin/env node
/**
 * Sends the releases a deploy added to `changelog.json` to the social-driver webhook, which turns
 * each into a draft post for the owner to finish and approve there. Nothing here publishes.
 *
 *   node scripts/changelog/announce.mjs --from <sha> --to <sha> [--dry-run]
 *
 * Env:
 *   SOCIAL_DRIVER_WEBHOOK_URL    the webhook; unset means a notice and exit 0 (forks, self-hosters)
 *   SOCIAL_DRIVER_WEBHOOK_TOKEN  sent as the bearer token and used as the HMAC-SHA256 key of
 *                                `X-Lines-Signature`, so a leaked URL alone cannot create drafts
 *   LINES_PUBLIC_URL             defaults to https://run.linesapp.cloud, the web app's origin; image
 *                                URLs are made against it (web/public/changelog-media ships there)
 *
 * One payload per added release, keyed `lines-<track>@<version>`: web and desktop versions are
 * separate series. An all-zero `--from` (a branch's first push) announces nothing rather than
 * everything. A non-2xx response fails this step; the deploy job is separate and stays green.
 */

import crypto from 'node:crypto';
import { addedReleases, readChangelogAt, ZERO_SHA } from './added.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const from = flag('--from');
const to = flag('--to');
const dryRun = args.includes('--dry-run');

if (!from || !to) {
  console.error('usage: announce.mjs --from <sha> --to <sha> [--dry-run]');
  process.exit(2);
}

if (ZERO_SHA.test(from)) {
  console.log(`::notice::No previous commit (${from}); announcing nothing.`);
  process.exit(0);
}

const PUBLIC_URL = (process.env.LINES_PUBLIC_URL || 'https://run.linesapp.cloud').replace(/\/$/, '');
const url = process.env.SOCIAL_DRIVER_WEBHOOK_URL;
const token = process.env.SOCIAL_DRIVER_WEBHOOK_TOKEN;

const added = addedReleases(readChangelogAt(from), readChangelogAt(to));
if (added.length === 0) {
  console.log('No releases added; nothing to announce.');
  process.exit(0);
}

const TRACK_LABELS = { web: 'Web app', desktop: 'Desktop app' };
const keyOf = ({ track, release }) => `${track}@${release.version}`;

// shared/changelog.ts itemText / itemImage; this script runs on bare Node without the workspace.
const itemText = (item) => (typeof item === 'string' ? item : item.text);
const itemImage = (item) => (typeof item === 'string' ? undefined : item.image);
/** Lines items are one line with no title of their own: the first sentence stands in for it. */
const titleOf = (text) => {
  const sentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  return sentence.length > 90 ? `${sentence.slice(0, 89).trimEnd()}…` : sentence;
};

const payloadOf = ({ track, release }) => ({
  source: 'lines',
  idempotencyKey: `lines-${keyOf({ track, release })}`,
  track,
  title: `${TRACK_LABELS[track]} ${release.version}`,
  version: release.version,
  date: release.date,
  url: PUBLIC_URL,
  items: release.items.map((item) => {
    const text = itemText(item);
    const image = itemImage(item);
    return {
      title: titleOf(text),
      body: text,
      ...(image ? { imageUrl: `${PUBLIC_URL}/changelog-media/${encodeURIComponent(image)}` } : {}),
    };
  }),
});

if (!dryRun && (!url || !token)) {
  console.log(
    `::notice::SOCIAL_DRIVER_WEBHOOK_URL or SOCIAL_DRIVER_WEBHOOK_TOKEN is unset; not announcing ${added
      .map(keyOf)
      .join(', ')}.`,
  );
  process.exit(0);
}

let failed = false;
// Oldest first per track, so drafts arrive in the order the releases shipped.
for (const entry of [...added].reverse()) {
  const body = JSON.stringify(payloadOf(entry));
  if (dryRun) {
    console.log(body);
    continue;
  }
  const signature = crypto.createHmac('sha256', token).update(body).digest('hex');
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Lines-Signature': `sha256=${signature}`,
      },
      body,
    });
    if (response.ok) {
      console.log(`Announced ${keyOf(entry)} (${response.status}).`);
    } else {
      failed = true;
      const text = await response.text().catch(() => '');
      console.log(`::error::Announcing ${keyOf(entry)} failed: ${response.status} ${text.slice(0, 200)}`);
    }
  } catch (error) {
    failed = true;
    console.log(`::error::Announcing ${keyOf(entry)} failed: ${error.message}`);
  }
}

process.exit(failed ? 1 : 0);
