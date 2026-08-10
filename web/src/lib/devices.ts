import { create } from 'zustand';
import { listDevices, type Device } from './storage';

/**
 * The paired-machine list, as shared state.
 *
 * It lives in its own store rather than the main one because two unrelated parts
 * of the tree depend on it and must agree: the gate that decides whether the app
 * can run at all, and the settings pane that adds and revokes machines. Revoking
 * the active machine there has to put the gate back up, which a component-local
 * fetch cannot do.
 *
 * Nothing here belongs in the main store: that one is a projection of bridge
 * messages, and these rows come from storage over HTTP.
 */
interface DevicesState {
  /** Null means "not loaded yet" — distinct from an empty list, which means "no machines". */
  devices: Device[] | null;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useDevices = create<DevicesState>((set) => ({
  devices: null,
  error: null,
  refresh: async () => {
    try {
      set({ devices: await listDevices(), error: null });
    } catch (err) {
      // The list is left as-is on failure: dropping to null would tear the app
      // down to the pairing screen every time the network hiccups.
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
}));

/** Imperative refresh for non-React callers (the socket, on a rejected connection). */
export function refreshDevices(): void {
  void useDevices.getState().refresh();
}
