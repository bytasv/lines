import type {
  BridgeInfo,
  SessionMeta,
  ShareProfile,
  ShareScope,
  StorageStatus,
  UpdateStatus,
  WorkerStatus,
} from '@lines/shared';

/**
 * Per-machine state and the merge rules that keep two machines' sessions apart.
 *
 * Free of React and the store on purpose. These are the reducers that a
 * single-machine client got away with doing wholesale — replace the session map,
 * prune every draft that has no session — and each of them silently destroys
 * another machine's state once two are held at once. Pure functions so they can
 * be tested directly; the store only supplies them with its current state.
 */

export type ConnectionState = 'connected' | 'reconnecting' | 'offline';

/** Everything the client knows about one machine it is holding a link to. */
export interface MachineSlice {
  deviceId: string;
  /** Owner of the machine, or the grant that reaches it. */
  scope: ShareScope;
  connectionStatus: ConnectionState;
  /** The relay says no bridge is attached — a fact, distinct from a dead link. */
  machineOffline: boolean;
  /** A `hello` has landed, so this machine's slice describes something real. */
  bootstrapped: boolean;
  worker: WorkerStatus | null;
  storage: StorageStatus | null;
  /** Desktop update this machine is offering; null until a `hello` or transition says so. */
  update: UpdateStatus | null;
  /** Which bridge this machine is running; null until its `hello`, and on a bridge
   *  too old to send the field — which is itself skew (see SkewBanner). Per-machine
   *  because the pill describes the machine in front of the user, and two links can
   *  be held at once. */
  bridge: BridgeInfo | null;
  /** Whose machine it is, when it is not ours. */
  ownerProfile: ShareProfile | null;
}

export const emptyMachine = (deviceId: string): MachineSlice => ({
  deviceId,
  scope: 'owner',
  connectionStatus: 'reconnecting',
  machineOffline: false,
  bootstrapped: false,
  worker: null,
  storage: null,
  update: null,
  bridge: null,
  ownerProfile: null,
});

/**
 * Fold one machine's `hello` into a session map that may hold several machines'
 * sessions.
 *
 * The single-machine version replaced the whole map. Doing that with two links
 * open means whichever machine said `hello` last wins and the other's sessions
 * vanish from the sidebar — so this drops only the sessions *stamped to this
 * machine* that the machine no longer reports, and leaves every other stamp
 * alone.
 *
 * Unstamped sessions are adopted by the machine whose hello mentions them: on a
 * first connection nothing is stamped yet, and on an upgrade from a
 * single-machine client the existing map has no stamps at all.
 */
export function mergeMachineSessions(input: {
  sessions: Record<string, SessionMeta>;
  sessionMachine: Record<string, string>;
  deviceId: string;
  incoming: SessionMeta[];
}): { sessions: Record<string, SessionMeta>; sessionMachine: Record<string, string> } {
  const live = new Set(input.incoming.map((s) => s.id));
  const sessions: Record<string, SessionMeta> = {};
  const sessionMachine: Record<string, string> = {};

  for (const [id, session] of Object.entries(input.sessions)) {
    const owner = input.sessionMachine[id];
    // Another machine's session: untouched, whatever this hello says.
    if (owner && owner !== input.deviceId) {
      sessions[id] = session;
      sessionMachine[id] = owner;
      continue;
    }
    // Ours (or unstamped) and still reported: the incoming copy wins below.
    // Ours and absent from the hello: gone on that machine, so dropped here.
    if (live.has(id)) continue;
    if (!owner) {
      // Unstamped and unclaimed by this hello. Keep it rather than guessing —
      // it may belong to a machine whose link has not opened yet, and dropping
      // it would make sessions flicker out on every reconnect.
      sessions[id] = session;
    }
  }

  for (const session of input.incoming) {
    sessions[session.id] = session;
    sessionMachine[session.id] = input.deviceId;
  }
  return { sessions, sessionMachine };
}

/**
 * Which stored drafts this machine's `hello` may delete.
 *
 * The rule that matters is what it *excludes*. A draft is only prunable when we
 * positively know it belonged to a session on this machine that the machine no
 * longer has. A draft for a session id we have never seen — another machine's,
 * one whose link is not open yet — is left alone: unscoped pruning here deletes
 * text the user typed and has not sent, which is unrecoverable.
 */
export function prunableDraftIds(input: {
  draftIds: string[];
  sessionMachine: Record<string, string>;
  deviceId: string;
  /** Session ids this machine just reported. */
  live: Set<string>;
}): string[] {
  return input.draftIds.filter(
    (id) => input.sessionMachine[id] === input.deviceId && !input.live.has(id),
  );
}

/**
 * Whether a session arriving in an upsert should steal the selection.
 *
 * Two pre-existing halves, unchanged: this client must have asked for a session
 * (`pendingCreate`), and the session must be one it has never seen — `createdAt`
 * is stamped on the bridge machine, so a clock even slightly ahead made every
 * upsert look freshly created and any session re-entering the map stole the view.
 *
 * The multi-machine half is `fromPrimary`. Without it, the host creating a
 * session on their own laptop yanks a guest's view across to it mid-sentence,
 * because the guest's client is holding that machine's link too.
 */
export function shouldClaimSelection(input: {
  fromPrimary: boolean;
  pendingCreate: boolean;
  alreadySeen: boolean;
}): boolean {
  return input.fromPrimary && input.pendingCreate && !input.alreadySeen;
}
