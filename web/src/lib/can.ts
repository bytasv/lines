import type { ShareCaps, ShareProfile, StorageStatus, WorkerStatus } from '@lines/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store';
import { readHostDeviceId } from './e2ee';

/**
 * What this browser may do on the machine it is connected to.
 *
 * Reads the `access` block the bridge sent on `hello`, which is derived from the
 * same grant the bridge enforces — so the UI hides exactly what would be refused,
 * rather than a hand-maintained second opinion about it. On your own machine
 * `access` is null and everything is permitted.
 *
 * Hiding is never the security boundary: `MESSAGE_AUTHZ` on the bridge is. This
 * only keeps a guest from clicking things that would answer with an error.
 */
export function useCan(cap: keyof ShareCaps): boolean {
  return useStore((s) => !s.access || s.access.caps[cap]);
}

/**
 * `useCan`, judged by the machine that hosts this session rather than the
 * primary one: the merged sidebar lists sessions from several machines at once,
 * each under its own grant (or none, on your own machine).
 */
export function useCanOnSession(sessionId: string, cap: keyof ShareCaps): boolean {
  return useStore((s) => {
    const deviceId = s.sessionMachine[sessionId] ?? s.primaryDeviceId ?? '';
    const slice = s.machines[deviceId];
    // No slice yet: fall back to the primary's answer, the same as `useCan`.
    const access = slice ? slice.view.access : s.access;
    return !access || access.caps[cap];
  });
}

/** True when connected to somebody else's machine. */
export function useIsGuest(): boolean {
  return useStore((s) => s.access !== null);
}

/**
 * `useIsGuest`, judged by the machine that hosts this session — the same lookup
 * as `useCanOnSession`. For what is the host's alone whatever the grant says,
 * such as the allowlist a permission card's "Always allow" would widen.
 */
export function useIsGuestOnSession(sessionId: string): boolean {
  return useStore((s) => {
    const deviceId = s.sessionMachine[sessionId] ?? s.primaryDeviceId ?? '';
    const slice = s.machines[deviceId];
    const access = slice ? slice.view.access : s.access;
    return !!access;
  });
}

/**
 * Whether this session is one the connection may act on at all. A machine-scope
 * guest sees every session; a session-scoped one sees exactly their list.
 */
export function useInScope(sessionId: string): boolean {
  return useStore(
    (s) => !s.access || s.access.scope === 'machine' || !!s.access.sessionIds?.includes(sessionId),
  );
}

/**
 * Whether *this* user has to connect a Claude account before turns can run.
 *
 * False on somebody else's machine, always. A guest's `hello` reports
 * `loggedIn: false` because the host's Claude account is deliberately withheld —
 * that is "not yours to see", not "you must sign in". Turns there run on the
 * host's token, so offering a guest a sign-in button asks them to fix something
 * they cannot see, do not own, and would not help by changing.
 */
export function useClaudeLoginNeeded(): boolean {
  return useStore((s) => s.auth?.loggedIn === false && s.access === null);
}

/**
 * Whether the machine this UI is pointed at is the one the browser runs on.
 *
 * The only thing this gates is a control that opens a native dialog on the host
 * — "Browse…", which shells out to Finder. From a phone or a second laptop that
 * dialog appears on a screen nobody is looking at, so the control is hidden
 * rather than disabled: recents and the typed path already cover the remote
 * case, and a greyed-out button with no remote equivalent just reads as broken.
 */
export function useIsLocalMachine(): boolean {
  return useStore((s) => {
    const deviceId = s.primaryDeviceId ?? '';
    return s.machines[deviceId]?.local ?? false;
  });
}

/**
 * Whether to offer controls that open a native folder dialog on the host.
 *
 * A browser on the host qualifies, and so does the desktop shell's own window:
 * its socket is relayed, so the bridge calls it non-local, but the shell told it
 * which machine it sits at (`readHostDeviceId`). A guest never qualifies — the
 * dialog would open on somebody else's desk.
 */
export function useCanBrowseFolders(): boolean {
  const isLocal = useIsLocalMachine();
  const guest = useIsGuest();
  const primary = useStore((s) => s.primaryDeviceId);
  if (isLocal) return true;
  if (guest || !primary) return false;
  return readHostDeviceId() === primary;
}

/**
 * The machine hosting a session, and whether it is the one the user is on.
 *
 * `projectKeys` groups sessions across installs by design, so a colleague's
 * session in the same repo lands in *your* existing project tab — which is the
 * right grouping and exactly why the row itself has to say whose machine it runs
 * on. Without that, two identically-named sessions in one tab are
 * indistinguishable, and typing into the wrong one is silent.
 */
/*
 * Both machine hooks below build a fresh object per call, so they must compare
 * shallowly: zustand v5 feeds the selector straight to useSyncExternalStore,
 * which treats a new reference as new state and re-renders forever.
 */
export function useSessionMachine(sessionId: string): {
  deviceId: string | null;
  isRemote: boolean;
  ownerProfile: ShareProfile | null;
} {
  return useStore(
    useShallow((s) => {
      const deviceId = s.sessionMachine[sessionId] ?? null;
      const primary = s.primaryDeviceId ?? '';
      return {
        deviceId,
        // Remote means "not the machine this UI is pointed at" — true for a shared
        // machine's session sitting in the merged list.
        isRemote: deviceId !== null && deviceId !== primary,
        ownerProfile: (deviceId ? s.machines[deviceId]?.ownerProfile : null) ?? null,
      };
    }),
  );
}

/**
 * The health of the machine hosting a session, from that machine's own slice.
 *
 * The scalars the banners read describe the *primary* machine by design. A
 * session on a shared machine has to be judged by its own link, or the composer
 * would happily accept a prompt for a laptop that is shut because the machine in
 * front of you is fine.
 */
export function useSessionMachineHealth(sessionId: string): {
  connected: boolean;
  bridgeAttached: boolean;
  worker: WorkerStatus | null;
  storage: StorageStatus | null;
} {
  return useStore(
    useShallow((s) => {
      const deviceId = s.sessionMachine[sessionId] ?? s.primaryDeviceId ?? '';
      const slice = s.machines[deviceId];
      return {
        // No slice yet means no `hello` from it — treat as not connected rather
        // than assuming health we have no evidence for.
        connected: slice?.connectionStatus === 'connected',
        bridgeAttached: slice ? !slice.machineOffline : false,
        worker: slice?.worker ?? null,
        storage: slice?.storage ?? null,
      };
    }),
  );
}
