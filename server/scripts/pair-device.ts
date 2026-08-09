/**
 * Register this machine with a hosted Lines install and print its pairing code.
 *
 *   npm run pair -w server            # STORAGE_URL from the repo-root .env
 *   npm run pair -w server -- --storage https://api.example.com
 *
 * Idempotent: once the device is claimed this prints "already paired" and exits
 * 0, so Tilt can run it on every `tilt up` without a branch.
 *
 * The desktop app does exactly the same thing on launch — this exists so the
 * agent side can be run from Tilt (or a bare terminal) without Electron.
 */
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

const { deviceIdentity, registerDevice } = await import('../src/device.ts');

const args = process.argv.slice(2);
const flagIndex = args.indexOf('--storage');
// Same variable the bridge itself syncs against, so pairing can never register
// this machine with one install while the bridge talks to another.
const storageUrl = (flagIndex >= 0 ? args[flagIndex + 1] : undefined) ?? process.env.STORAGE_URL;

if (!storageUrl) {
  console.error('No storage URL. Pass --storage https://api.<domain> or set STORAGE_URL in .env.');
  process.exit(1);
}

const identity = deviceIdentity();
const code = await registerDevice(storageUrl, identity);

if (!code) {
  console.log(`device ${identity.id} is already paired`);
} else {
  console.log('');
  console.log(`  Pairing code:  ${code}`);
  console.log('');
  console.log('  Enter it in the Lines web app to connect this machine.');
  console.log('  Expires in 15 minutes; re-run this to get a new one.');
  console.log('');
}
