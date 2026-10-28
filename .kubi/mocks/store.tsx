import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useStore as appStore } from '../../web/src/store';

export * from '../../web/src/store';

// The app's zustand store is one module-wide singleton, so every island on the
// canvas reads the same state — fine for sessions (each story names its own id),
// wrong for page-wide facts like `connectionStatus`: a "Disconnected" banner
// story would knock every other component on the canvas offline too.
//
// This keeps the real store and lets a subtree read a patched copy of it
// instead. `StoreOverrides` (applied from `parameters.store` in kubi.config)
// layers fields over the live state for its children only; outside one,
// `useStore` is the app's hook unchanged. Writes always go to the real store.

type State = ReturnType<typeof appStore.getState>;

const Overrides = createContext<Partial<State> | null>(null);

export function StoreOverrides({ value, children }: { value: Partial<State>; children?: ReactNode }) {
  const outer = useContext(Overrides);
  const merged = useMemo(() => (outer ? { ...outer, ...value } : value), [outer, value]);
  return <Overrides.Provider value={merged}>{children}</Overrides.Provider>;
}

const whole = (s: State) => s;

function useScopedStore<T>(selector: (s: State) => T = whole as (s: State) => T): T {
  const overrides = useContext(Overrides);
  // Under an override, subscribe to the whole state (a stable reference until a
  // write) and run the selector on the patched copy here, outside zustand's
  // snapshot: `useShallow` selectors keep a ref, and running one on two
  // different states inside useSyncExternalStore would never settle.
  const picked = appStore(overrides ? (whole as (s: State) => T) : selector);
  const patched = useMemo(
    () => (overrides ? { ...(picked as unknown as State), ...overrides } : null),
    [picked, overrides],
  );
  return patched ? selector(patched) : picked;
}

export const useStore = Object.assign(useScopedStore, appStore) as typeof appStore;
