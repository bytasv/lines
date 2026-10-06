/**
 * Whether a frame that arrived in the clear may be applied to a link.
 *
 * Pure, so the server's runner can test it (server/src/plaintextFrames.test.ts);
 * ws.ts asks it for every frame that is not one of the handshake's own.
 *
 * Keyed on whether the link opened with a pinned machine key, not on how far
 * its handshake has got: on a pinned link the machine seals every app frame, so
 * a plaintext one can only have been written by something in the middle — the
 * relay — at any point in the link's life, before the handshake, during it or
 * after. Applying it would let the relay put a forged transcript, a fake
 * permission card or a wrong session list on screen. The relay's own two control
 * frames are the exception: they are about the machine rather than from it, and
 * could never be sealed. A link with no pin — a direct bridge, or a machine this
 * browser never enrolled with — takes plaintext as it always has.
 */
export function plaintextFrameAllowed(pinned: boolean, type: string): boolean {
  if (type === 'deviceOffline' || type === 'deviceOnline') return true;
  return !pinned;
}
