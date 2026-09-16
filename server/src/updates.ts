/**
 * Update state, relayed between the desktop shell and the browser.
 *
 * The shell owns downloading and installing; the bridge owns the one thing the
 * shell cannot know — whether a session is mid-turn. A restart always kills
 * in-flight turns, so "Restart now" is refused until the app is idle.
 *
 * Entirely inert when the channel to the shell is absent (`process.send`
 * missing, which is every Tilt and `npm run dev` run) or already closed — a send
 * into a closed channel throws synchronously and would take the bridge down with
 * a shell that went away first.
 */
import { isSessionActive, type ServerMessage, type SessionMeta, type UpdateStatus } from '@lines/shared';

/** Messages exchanged with the desktop shell over the Node IPC channel. */
type ToShell = { type: 'updateRestartRequest' } | { type: 'relayStatus'; status: RelayLinkStatus };
type FromShell = { type: 'updateStatus'; status: UpdateStatus };

/**
 * Whether the outbound relay link is up, as the shell's tray reports it.
 *
 * Shares the update channel rather than opening a second one — it is the same
 * parent process and the same one-way needs. Kept in this module so the whole
 * bridge↔shell IPC contract is one file.
 */
export interface RelayLinkStatus {
  connected: boolean;
  /**
   * Close code, when a socket that had opened went away. `1008` is the relay
   * refusing this device — unpaired or revoked — which is the difference between
   * "connecting" and "not paired" in the tray.
   */
  code?: number;
  reason?: string;
}

/**
 * Tell the shell the relay link changed. A no-op under Tilt and `npm run dev`,
 * where nothing is listening — same inertness as the rest of this module.
 */
export function reportRelayStatus(status: RelayLinkStatus): void {
  if (process.connected) process.send?.({ type: 'relayStatus', status } satisfies ToShell, () => {});
}

export class UpdateManager {
  private status: UpdateStatus = { state: 'idle' };

  /**
   * @param listSessions every session, so a restart can be refused while any is active
   * @param broadcast    fan-out to this user's browsers
   */
  constructor(
    private listSessions: () => SessionMeta[],
    private broadcast: (msg: ServerMessage) => void,
  ) {
    process.on('message', (msg: FromShell) => {
      if (msg?.type !== 'updateStatus') return;
      this.status = msg.status;
      this.broadcast({ type: 'updateStatus', status: this.current() });
    });
  }

  /** True when the shell is supervising us; false under Tilt / npm run dev. */
  get supervised(): boolean {
    return typeof process.send === 'function' && process.env.LINES_DEV_SUPERVISED !== '1';
  }

  /** A turn dies on restart, so an active session blocks it. */
  get busy(): boolean {
    return this.listSessions().some((s) => isSessionActive(s.status));
  }

  /** Status as the client should see it, with the live busy flag folded in. */
  current(): UpdateStatus {
    return { ...this.status, restartBlocked: this.busy };
  }

  /**
   * Ask the shell to restart. Refused while any session is active — the caller
   * gets `false` and the UI keeps saying "will apply when idle".
   */
  requestRestart(): boolean {
    if (!this.supervised || this.busy) return false;
    if (process.connected) process.send?.({ type: 'updateRestartRequest' } satisfies ToShell, () => {});
    return true;
  }
}
