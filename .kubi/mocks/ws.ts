import type { ClientMessage } from '@lines/shared';

export * from '../../web/src/ws';

// No bridge behind Kubi's canvas. The real `send` parks prompts in the offline
// queue for a reconnect that never comes; here every message is accepted and
// dropped, so Send, Stop and the permission buttons are clickable and inert.
export function send(_msg: ClientMessage): boolean {
  return true;
}
