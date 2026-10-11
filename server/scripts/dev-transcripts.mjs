// Points the dev data root's per-user transcripts and attachments at the prod root's,
// so the dev bridge replays the same history, images included. Idempotent; never
// touches a non-empty dev folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const devRoot = process.env.LINES_APP_ROOT;
const prodRoot = path.join(os.homedir(), '.lines-app');
if (!devRoot || path.resolve(devRoot) === path.resolve(prodRoot)) process.exit(0);

const prodUsers = path.join(prodRoot, 'users');
let users = [];
try {
  users = fs.readdirSync(prodUsers);
} catch {
  process.exit(0);
}

for (const user of users) for (const folder of ['transcripts', 'attachments']) {
  const src = path.join(prodUsers, user, folder);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) continue;

  const devUser = path.join(devRoot, 'users', user);
  const target = path.join(devUser, folder);
  fs.mkdirSync(devUser, { recursive: true });

  let stat = null;
  try {
    stat = fs.lstatSync(target);
  } catch {
    // absent: link below
  }

  if (stat?.isSymbolicLink()) {
    if (fs.realpathSync(target) === fs.realpathSync(src)) continue;
    console.warn(`[transcripts] ${target} links elsewhere; leaving it alone`);
    continue;
  }
  if (stat?.isDirectory()) {
    if (fs.readdirSync(target).length > 0) {
      console.warn(`[transcripts] ${target} has its own transcripts; leaving it alone`);
      continue;
    }
    fs.rmdirSync(target);
  } else if (stat) {
    console.warn(`[transcripts] ${target} is not a folder; leaving it alone`);
    continue;
  }

  fs.symlinkSync(src, target, 'dir');
  console.log(`[transcripts] ${target} -> ${src}`);
}
