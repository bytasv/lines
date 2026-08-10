import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MantineProvider } from '@mantine/core';
import { ClerkProvider, RedirectToSignIn, SignedIn, SignedOut, useAuth, useUser } from '@clerk/clerk-react';
import '@mantine/core/styles.css';
import './index.css';
import { theme } from './theme';
import { App } from './App';
import { connect, setTokenProvider, switchDevice } from './ws';
import { CLERK_ENABLED, CLERK_PUBLISHABLE_KEY, setOwnerId, setOwnerName } from './lib/clerk';
import {
  chooseDevice,
  DEVICE_PAIRING_ENABLED,
  rememberDeviceId,
  setStorageTokenProvider,
} from './lib/storage';
import { useDevices } from './lib/devices';
import {
  ConnectMachine,
  ConnectMachineError,
  ConnectMachineLoading,
} from './components/ConnectMachine';
import { ConnectingMachine } from './components/ConnectingMachine';
import { useStore } from './store';

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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const chosen = devices ? chooseDevice(devices) : null;

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
  if (!chosen) return <ConnectMachine />;
  // Chosen but not yet heard from: the socket has to open AND deliver `hello`
  // before the store describes anything. Rendering the app in between shows a
  // built-out UI with no sessions in it, behind a red "disconnected" pill.
  if (!bootstrapped) return <ConnectingMachine name={chosen.name} />;
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
  setTokenProvider(() => getToken());
  setStorageTokenProvider(() => getToken());
  useEffect(() => {
    // With pairing on, DeviceGate owns the connect() call: opening the socket
    // before a device is known guarantees a 1008 and a reconnect loop.
    if (!DEVICE_PAIRING_ENABLED) void connect();
  }, [getToken]);
  useEffect(() => {
    setOwnerName(user?.fullName || user?.username || user?.primaryEmailAddress?.emailAddress || null);
    setOwnerId(user?.id ?? null);
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
      <SignedIn>
        <AuthedConnect />
      </SignedIn>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
    </ClerkProvider>
  );
}

// Without Clerk the socket needs no token — connect immediately as before.
// connect() resolves the bridge's port itself, so nothing has to await it here:
// every workspace read now goes over that same socket.
if (!CLERK_ENABLED) void connect();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <MantineProvider theme={theme} defaultColorScheme="dark">
        <Root />
      </MantineProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
