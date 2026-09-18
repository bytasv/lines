/**
 * Mint this machine's one-time encryption code, and list what is enrolled.
 *
 *   npm run enroll -w server            # print a fresh code
 *   npm run enroll -w server -- --list  # show enrolled browsers
 *   npm run enroll -w server -- --revoke <fingerprint|publicKey>
 *
 * The desktop tray does exactly this ("Show encryption code…"), which is why
 * this exists: under Tilt — and on any headless bridge — there is no Electron
 * shell, so without it the end-to-end encryption flow could not be exercised
 * locally at all. Same three files under `~/.lines-app`, same TTL, same
 * single-use rule: the two paths must not drift.
 */
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

const { ENROLL_TTL_MS, bridgeIdentity, currentEnrollment, listPeers, mintEnrollmentCode, revokePeer } =
  await import('../src/e2eeIdentity.ts');

const args = process.argv.slice(2);

function printPeers(): void {
  const peers = listPeers();
  if (!peers.length) {
    console.log('No browser is enrolled — traffic over the relay is not end-to-end encrypted.');
    return;
  }
  console.log('Enrolled browsers:');
  for (const peer of peers) {
    const seen = peer.lastSeenAt ? new Date(peer.lastSeenAt).toLocaleString() : 'never';
    console.log(`  ${peer.fingerprint}  ${peer.label}  (last seen ${seen})`);
  }
}

if (args.includes('--list')) {
  // The machine key is printed too: it is what a client pins, and seeing both
  // ends' fingerprints side by side is how a human checks an enrollment landed.
  const identity = await bridgeIdentity();
  console.log(`machine key: ${identity.publicKey}`);
  printPeers();
  process.exit(0);
}

const revokeIndex = args.indexOf('--revoke');
if (revokeIndex >= 0) {
  const target = args[revokeIndex + 1];
  if (!target) {
    console.error('Pass the fingerprint or public key to revoke: --revoke 1a2b-3c4d-…');
    process.exit(1);
  }
  const peer = listPeers().find((p) => p.fingerprint === target || p.publicKey === target);
  if (!peer) {
    console.error(`No enrolled browser matches ${target}.`);
    process.exit(1);
  }
  revokePeer(peer.publicKey);
  console.log(`revoked ${peer.fingerprint} (${peer.label}) — its next connection is refused`);
  process.exit(0);
}

// Minting replaces whatever code was outstanding, which is the safe direction:
// only one enrollment can ever be open at a time.
const existing = currentEnrollment();
if (existing && args.includes('--keep')) {
  console.log(`  Encryption code:  ${existing.code.replace(/(.{5})(?=.)/g, '$1 ')}`);
  console.log(`  Expires ${new Date(existing.expiresAt).toLocaleTimeString()}`);
  process.exit(0);
}

const { code, expiresAt } = mintEnrollmentCode();
const identity = await bridgeIdentity();

console.log('');
console.log(`  Encryption code:  ${code.replace(/(.{5})(?=.)/g, '$1 ')}`);
console.log('');
console.log('  Enter it in the Lines web app under Settings → Encryption.');
console.log(`  Works once, expires in ${Math.round(ENROLL_TTL_MS / 60_000)} minutes ` +
  `(${new Date(expiresAt).toLocaleTimeString()}).`);
console.log(`  This machine's key fingerprint will be pinned by that browser.`);
console.log(`  machine key: ${identity.publicKey}`);
console.log('');
printPeers();
