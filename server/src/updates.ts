/**
 * Update state, relayed between the desktop shell and the browser.
 *
 * The shell owns downloading and installing; the bridge owns the one thing the
 * shell cannot know — whether a session is mid-turn. A restart always kills
 * in-flight turns, so "Restart now" is refused until the app is idle.
 *
 * Entirely inert when the bridge was not spawned by the shell (`process.send`
 * absent), which is every Tilt and `npm run dev` run.
 */
import { isSessionActive, type ServerMessage, type SessionMeta, type UpdateStatus } from '@lines/shared';

/** Messages exchanged with the desktop shell over the Node IPC channel. */
type ToShell = { type: 'updateRestartRequest' };
type FromShell = { type: 'updateStatus'; status: UpdateStatus };

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
    return typeof process.send === 'function';
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
    process.send?.({ type: 'updateRestartRequest' } satisfies ToShell);
    return true;
  }
}
