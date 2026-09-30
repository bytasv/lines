import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { MantineProvider } from '@mantine/core';
import {
  ClerkLoaded,
  ClerkLoading,
  ClerkProvider,
  SignedIn,
  SignedOut,
  useAuth,
  useUser,
} from '@clerk/clerk-react';
import '@mantine/core/styles.css';
import './index.css';
import { theme } from './theme';
import { App } from './App';
import {
  connect,
  connectMachine,
  disconnectMachine,
  reconnectNow,
  setCachedTokenProvider,
  setTokenProvider,
  switchDevice,
} from './ws';
import { diag, diagSource, noteDesktopWindow } from './lib/diag';
import {
  CLERK_ENABLED,
  CLERK_PUBLISHABLE_KEY,
  setOwnerId,
  setOwnerImageUrl,
  setOwnerName,
} from './lib/clerk';
import {
  chooseDevice,
  DEVICE_PAIRING_ENABLED,
  forgetDeviceId,
  rememberDeviceId,
  rememberedDeviceId,
  revokeDevice,
  setStorageTokenProvider,
} from './lib/storage';
import { useDevices } from './lib/devices';
import { bootDial } from './lib/wake';
import { trackKeyboardInset } from './lib/viewport';
import { learnHostDeviceIdFromDevServer, takeHostDeviceIdFromUrl } from './lib/e2ee';
import { registerServiceWorker } from './lib/push';
import {
  ConnectMachine,
  ConnectMachineError,
  ConnectMachineLoading,
} from './components/ConnectMachine';
import { ChooseMachine } from './components/ChooseMachine';
import { ConnectingMachine } from './components/ConnectingMachine';
import { JoinPage } from './components/JoinPage';
import { LandingPage } from './components/LandingPage';
import { useStore } from './store';

noteDesktopWindow(location.hash);
// First line of every page load: a reload, a PWA relaunch and a discarded tab
// all look alike from inside the connect path, and this is what tells them apart.
diag('boot', {
  source: diagSource(),
  nav: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type ?? null,
  visible: !document.hidden,
  online: navigator.onLine,
  remembered: rememberedDeviceId(),
});

/**
 * Gate between signing in and opening the socket, in deployments where the agent
 * runs on the user's own machine. There is nothing to connect to until one is
 * paired, and the relay rejects a socket that names no device — so this resolves
 * the device first and only then calls connect().
 *
 * Skipped entirely when VITE_STORAGE_URL is unset: that build talks to a local
 * bridge, which is itself the one and only machine.
 */
function DeviceGate({ children }: { children: React.ReactNode }) {
  // Shared with the Machines settings pane, so revoking the machine in use there
  // puts this gate straight back up instead of leaving a dead app on screen.
  const devices = useDevices((s) => s.devices);
  const error = useDevices((s) => s.error);
  const refresh = useDevices((s) => s.refresh);
  const bootstrapped = useStore((s) => s.bootstrapped);
  /** Set from the connecting screen when the automatic choice is unreachable. */
  const [pickedId, setPickedId] = useState<string | null>(null);
  /** Show the pairing form even though a machine is already chosen. */
  const [pairingNew, setPairingNew] = useState(false);
  /** The machine dialled before the list landed, if any. A ref: nothing renders from it. */
  const dialedRef = useRef<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Hold a link to every machine shared with this user, not just the one in
   * front of them: a shared session has to be visible in the sidebar alongside
   * your own, which means its machine's `hello` has to have arrived.
   *
   * Shares are few by nature, and ws.ts caps the link count and idle-disconnects
   * the ones you are not looking at — each link heartbeats once a second.
   */
  useEffect(() => {
    for (const device of devices ?? []) {
      if (device.shared) void connectMachine(device.id);
    }
  }, [devices]);

  // Leave the pairing form as soon as the account gains a machine, so a
  // successful claim lands in the app instead of sitting on a stale form.
  useEffect(() => {
    setPairingNew(false);
  }, [devices?.length]);

  /**
   * Which machine this browser drives.
   *
   * A manual pick wins over everything — that is the point of the picker below
   * and of `ConnectingMachine`'s switch list: the heuristic is what chose the
   * unreachable machine.
   *
   * Otherwise the heuristic applies **only once this browser has chosen before**.
   * On a first visit `rememberedDeviceId()` is null and the user picks
   * explicitly, even from a list of one: attaching silently never tells them
   * which computer they are about to run commands on.
   */
  const remembered = rememberedDeviceId();
  const chosen = devices
    ? (pickedId ? devices.find((d) => d.id === pickedId) : null) ??
      (remembered ? chooseDevice(devices) : null)
    : null;

  /**
   * Dial the remembered machine while the device list is still in flight.
   *
   * Cold boot was one serialized chain — Clerk, then the device list, then a
   * token, then the socket — even though the id the socket needs is a
   * localStorage read that is available immediately. This overlaps the socket
   * with the list instead of queueing it behind.
   *
   * `connectMachine`, deliberately not `switchDevice`: `primaryDeviceId` stays
   * unset until the effect below decides, so a wrong guess never becomes the
   * machine the UI is on. That effect then no-ops, because the socket is open.
   *
   * It has to be an effect in here rather than module scope: `setTokenProvider`
   * is assigned during AuthedConnect's render, and child effects are the first
   * thing to run after it.
   */
  useEffect(() => {
    const { dial, drop } = bootDial(remembered, devices, dialedRef.current);
    if (dial || drop) diag('boot-dial', { dial, drop });
    if (dial) {
      dialedRef.current = dial;
      void connectMachine(dial);
    }
    if (drop) {
      // The guess is not in the account's list — revoked, or never this
      // browser's. Left open it retries on 1008 every few seconds, and each
      // retry re-reads the device list.
      dialedRef.current = null;
      disconnectMachine(drop);
    }
  }, [devices, remembered]);

  useEffect(() => {
    if (!chosen) return;
    rememberDeviceId(chosen.id);
    // switchDevice, not setDeviceId: if the previous machine was revoked while
    // its socket was still open, that socket has to be closed before this one is
    // opened, or messages meant for the new machine go to the old one.
    switchDevice(chosen.id);
  }, [chosen]);

  // Only a failure with nothing cached is fatal — a refresh that fails while a
  // machine is already chosen leaves the app running on it.
  if (error && !devices) return <ConnectMachineError error={error} onRetry={() => void refresh()} />;
  if (!devices) return <ConnectMachineLoading />;
  // Nothing paired at all, or the user asked for the pairing form.
  if (devices.length === 0 || pairingNew) return <ConnectMachine />;
  // Paired, but this browser has never chosen — or chose a machine that has
  // since been revoked, which `chooseDevice` would otherwise paper over.
  if (!chosen) {
    return (
      <ChooseMachine
        devices={devices}
        onPick={(id) => {
          rememberDeviceId(id);
          setPickedId(id);
        }}
        onPairNew={() => setPairingNew(true)}
      />
    );
  }
  // Chosen but not yet heard from: the socket has to open AND deliver `hello`
  // before the store describes anything. Rendering the app in between shows a
  // built-out UI with no sessions in it, behind a red "disconnected" pill.
  if (!bootstrapped) {
    return (
      <ConnectingMachine
        name={chosen.name}
        deviceId={chosen.id}
        others={devices.filter((d) => d.id !== chosen.id)}
        onSwitch={setPickedId}
        onPairNew={() => setPairingNew(true)}
        onReconnect={async () => {
          reconnectNow();
          await refresh();
        }}
        onUnpair={async () => {
          await revokeDevice(chosen.id);
          // The same order DevicesSection.revoke uses, for the same reason: clear
          // the remembered choice before refreshing, or the gate briefly
          // re-selects a machine the relay will now refuse. With the row gone
          // `chosen` is null and this falls through to the pairing screen.
          forgetDeviceId();
          await refresh();
          setPickedId(null);
        }}
      />
    );
  }
  return <>{children}</>;
}

/** Rendered only when signed in: register the token source, then open the socket. */
function AuthedConnect() {
  const { getToken } = useAuth();
  const { user } = useUser();
  // Assigned during render, NOT in an effect: React runs child effects before
  // parent ones, so DeviceGate's device fetch and its connect() both fire first.
  // Registered from an effect, the first storage call goes out with no
  // Authorization header (401) and the first socket with no token (1008).
  // These are idempotent module-level assignments, so a re-render is harmless.
  // skipCache: Clerk's own memoised token is what the bridge kept 401ing on —
  // relayAuth's whole job is delivering a token the bridge hasn't seen fail
  // yet, so a cache hit here defeats it. Force a real mint every relay.
  setTokenProvider(() => getToken({ skipCache: true }));
  setCachedTokenProvider(() => getToken());
  setStorageTokenProvider(() => getToken());
  useEffect(() => {
    // Warm the token so the mint overlaps the rest of boot rather than sitting
    // in front of the first storage call and the socket. Clerk memoises until
    // near expiry, so this is one round trip saved and no token held here.
    void getToken().catch(() => null);
    // With pairing on, DeviceGate owns the connect() call: opening the socket
    // before a device is known guarantees a 1008 and a reconnect loop.
    if (!DEVICE_PAIRING_ENABLED) void connect();
  }, [getToken]);
  useEffect(() => {
    setOwnerName(user?.fullName || user?.username || user?.primaryEmailAddress?.emailAddress || null);
    setOwnerId(user?.id ?? null);
    setOwnerImageUrl(user?.imageUrl ?? null);
  }, [user]);
  if (!DEVICE_PAIRING_ENABLED) return <App />;
  return (
    <DeviceGate>
      <App />
    </DeviceGate>
  );
}

function Root() {
  if (!CLERK_ENABLED) return <App />;
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY!}>
      <Routes>
        {/* /welcome must render the landing page for BOTH SignedIn and SignedOut —
            it is the only way a signed-in user can re-read it, since every other
            path renders the app for them. Do not wrap this in an auth gate. */}
        <Route path="/welcome" element={<LandingPage />} />
        {/* Outside the auth gate on purpose, as /welcome is: the page renders its
            own signed-out state (which deliberately names nobody) and its own
            sign-in, because the invitee may have no account yet. Routing it
            through the gate would send them to the landing page and lose the
            code. */}
        <Route path="/join/:code" element={<JoinPage />} />
        {/* App mounts its own <Routes> underneath this splat (descendant routes),
            so /docs/* and /session/:id keep resolving against the full path. */}
        <Route
          path="*"
          element={
            <>
              {/* Both branches render nothing until Clerk has loaded, which is a
                  script fetch and a /v1/client round trip — long enough to read
                  as a blank page. Hold the gate's own spinner for that window so
                  the boot skeleton hands over to something, not to white. */}
              <ClerkLoading>
                <ConnectMachineLoading />
              </ClerkLoading>
              <ClerkLoaded>
                <SignedIn>
                  <AuthedConnect />
                </SignedIn>
                <SignedOut>
                  <LandingPage />
                </SignedOut>
              </ClerkLoaded>
            </>
          }
        />
      </Routes>
    </ClerkProvider>
  );
}

// Without Clerk the socket needs no token — connect immediately as before.
// connect() resolves the bridge's port itself, so nothing has to await it here:
// every workspace read now goes over that same socket.
if (!CLERK_ENABLED) void connect();

// Before the first render, and never torn down: the value it publishes is read
// by CSS on every full-height surface, including the gate screens that render
// instead of the app.
trackKeyboardInset();

// Before the first render too, so the "+" menu's Browse gate reads the value the
// desktop shell handed this window rather than last session's.
takeHostDeviceIdFromUrl();
// Dev only: the same answer for a plain browser tab on the dev machine, which a
// relayed bridge would otherwise treat like a phone.
void learnHostDeviceIdFromDevServer();

// Push-only (no fetch handler, no cache — see public/sw.js). A notification
// clicked while this window is open arrives here as `openSession`.
registerServiceWorker((id) => useStore.getState().openSessionFromAlert(id));

const rootElement = document.getElementById('root')!;
// Drop index.html's boot skeleton explicitly rather than leaving it to React's
// first commit: the removal is then tied to this line instead of to whenever the
// container is reconciled, and StrictMode's double render cannot flash it back.
rootElement.replaceChildren();

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <MantineProvider theme={theme} defaultColorScheme="dark">
        <Root />
      </MantineProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
