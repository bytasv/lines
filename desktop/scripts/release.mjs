#!/usr/bin/env node
/**
 * Publish the built app to the public R2 bucket.
 *
 * R2 rather than GitHub Releases: this is a private repo, so a release asset
 * would need a token path in the client for every download and for the update
 * feed. The R2 credentials already exist for recipe images (see
 * `storage/src/r2.ts`), so this reuses them and adds no new secret.
 *
 * It does NOT reuse that bucket. Public-read is a bucket-level setting, so
 * sharing one would make every user-uploaded recipe screenshot world-readable in
 * order to publish an installer. `R2_RELEASE_BUCKET` is a second bucket whose
 * entire contents are meant to be public, which makes "anyone can read this
 * bucket" a description of the intent rather than a risk to weigh.
 *
 * The DMG URL is unauthenticated by necessity — an installer nobody can download
 * is not an installer. That is a public artifact of a private product, which is
 * acceptable; a user's screenshots would not be.
 *
 * Uploads everything electron-builder produced: the DMG (the human download),
 * the zip and `latest-mac.yml` (what electron-updater reads), and the blockmaps.
 *
 * The DMG goes up twice: once under its versioned name (what `latest-mac.yml`
 * points at, immutable forever) and once as a fixed alias key, which is the only
 * thing the web app's download button ever needs to know. Without the alias
 * every release forces a `VITE_DESKTOP_DOWNLOAD_URL` edit and a web rebuild.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(DESKTOP, '..');
const RELEASE_DIR = path.join(DESKTOP, 'release');
/** Everything lives under one prefix, which is also the update feed URL. */
const PREFIX = 'desktop';
/** Stable download link: same bytes as the versioned DMG, name that never moves. */
const ALIAS = 'Lines-latest.dmg';

const { config } = require('dotenv');
config({ path: path.join(REPO, '.env') });

// Credentials are shared with storage; the bucket and its public base are not.
const required = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_RELEASE_BUCKET',
  'R2_RELEASE_PUBLIC_BASE_URL',
];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing R2 configuration: ${missing.join(', ')}`);
  if (missing.some((key) => key.startsWith('R2_RELEASE_'))) {
    console.error(
      'Releases go to their own public bucket, deliberately not the recipe-image one —\n' +
        'public-read is a bucket-level setting, and sharing it would publish user uploads.\n' +
        'The API token must be scoped to both buckets, or be account-level.',
    );
  }
  process.exit(1);
}

/**
 * The same trap `storage/src/r2.ts` guards for recipe images, and worse here: the
 * S3 API endpoint is what every R2 credentials page shows, but an unsigned GET
 * against it fails — so the upload would "succeed" and the DMG link baked into the
 * web image (and the update feed baked into the app) would both 400 forever.
 *
 * Duplicated rather than imported from `storage/src/r2.ts`: the desktop workspace
 * has no business depending on the storage server, and this is six lines.
 */
const publicBase = process.env.R2_RELEASE_PUBLIC_BASE_URL;
if (!/^https?:\/\//.test(publicBase)) {
  console.error('R2_PUBLIC_BASE_URL must be an absolute http(s) URL');
  process.exit(1);
}
if (/\.r2\.cloudflarestorage\.com/.test(publicBase)) {
  console.error(
    'R2_RELEASE_PUBLIC_BASE_URL points at the S3 API endpoint — nothing can download from it. ' +
      "Use the bucket's public r2.dev subdomain or a custom domain, with public access enabled.",
  );
  process.exit(1);
}

const CONTENT_TYPES = {
  '.dmg': 'application/x-apple-diskimage',
  '.zip': 'application/zip',
  '.yml': 'text/yaml; charset=utf-8',
  '.blockmap': 'application/octet-stream',
};

/**
 * electron-builder also drops `builder-debug.yml` here — its fully resolved
 * config, including absolute paths from the build machine. Nothing downloads it,
 * so it has no business in a public bucket: match the artifacts by name rather
 * than sweeping every `.yml` in the directory.
 */
const PUBLISHABLE = /(\.dmg|\.zip)(\.blockmap)?$|^latest-mac\.yml$/;

const files = fs.existsSync(RELEASE_DIR)
  ? fs.readdirSync(RELEASE_DIR).filter((name) => PUBLISHABLE.test(name) && CONTENT_TYPES[path.extname(name)])
  : [];
if (!files.length) {
  console.error(`No artifacts in ${RELEASE_DIR} — run \`npm run package -w desktop\` first.`);
  process.exit(1);
}

/**
 * A DMG left over from an earlier build is indistinguishable from this one's
 * here, and it would be published as the alias — the download link for everyone,
 * pointing at the wrong version. `npm run ship -w desktop` clears the directory
 * first; a bare `npm run upload` in a dirty tree is what this catches.
 */
const dmgs = files.filter((name) => name.endsWith('.dmg'));
if (dmgs.length !== 1) {
  console.error(
    `Expected exactly one .dmg in ${RELEASE_DIR}, found ${dmgs.length}: ${dmgs.join(', ') || '(none)'}\n` +
      'Clear the directory and repackage — `npm run ship -w desktop` does both.',
  );
  process.exit(1);
}
const [dmg] = dmgs;

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function upload(name, { key = `${PREFIX}/${name}`, cacheControl } = {}) {
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_RELEASE_BUCKET,
      Key: key,
      Body: fs.readFileSync(path.join(RELEASE_DIR, name)),
      ContentType: CONTENT_TYPES[path.extname(name)],
      // latest-mac.yml is polled: a cached copy would hide a release for hours.
      CacheControl: cacheControl ?? (name.endsWith('.yml') ? 'no-cache' : 'public, max-age=31536000, immutable'),
    }),
  );
  console.log(`uploaded ${key}`);
}

for (const name of files) await upload(name);

/**
 * Last, deliberately. The alias and the versioned DMG are two objects that can
 * disagree; uploading the alias after everything else means a partial failure
 * leaves it pointing at the previous good build rather than at a release whose
 * update feed never landed.
 *
 * `no-cache` for the same reason `latest-mac.yml` has it — an immutable alias
 * would serve this build for a year after the next one ships.
 */
await upload(dmg, { key: `${PREFIX}/${ALIAS}`, cacheControl: 'no-cache' });

const base = `${publicBase.replace(/\/$/, '')}/${PREFIX}`;
const aliasUrl = `${base}/${ALIAS}`;
console.log(`\nUpdate feed  LINES_UPDATE_FEED_URL=${base}`);
console.log(`Download     VITE_DESKTOP_DOWNLOAD_URL=${aliasUrl}`);
console.log(`Versioned    ${base}/${encodeURIComponent(dmg)}`);

// Surfaces the same three lines on the workflow run page; a no-op locally.
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Desktop release published\n\n` +
      `| | |\n| --- | --- |\n` +
      `| Download (stable) | ${aliasUrl} |\n` +
      `| Versioned | ${base}/${encodeURIComponent(dmg)} |\n` +
      `| Update feed | ${base} |\n`,
  );
}
