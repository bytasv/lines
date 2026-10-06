/**
 * Is this link coming from the machine the bridge runs on?
 *
 * The bridge listens on loopback by default, but it can be opened to every
 * interface on purpose (`LINES_BRIDGE_HOST`, for testing from a phone), and then
 * "not relayed" is not the same as "loopback": a direct socket can come from
 * another computer on the LAN. Only a loopback socket may drive something that
 * happens *at* this machine — today that is the Finder folder picker, which
 * opens a window on the host's screen and is useless to anybody else. The
 * connection policy (connectionPolicy.ts) asks the same question of a peer.
 *
 * Pure and dependency-free so it can be tested without standing a server up.
 */

/**
 * `remoteAddress` as Node reports it: dotted IPv4, IPv6, or an IPv4-mapped IPv6
 * address on a dual-stack listener. Anything unrecognised — including
 * `undefined` from a socket that has already gone away — is not local, because
 * failing closed here only hides a button.
 */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  // Strip a zone index (fe80::1%en0) and an IPv4-mapped prefix before matching.
  const addr = address.split('%')[0].toLowerCase();
  if (addr === '::1') return true;
  const v4 = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  // The whole 127.0.0.0/8 block, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}
