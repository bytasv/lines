import React, { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MantineProvider } from '@mantine/core';
import { ClerkProvider, RedirectToSignIn, SignedIn, SignedOut, useAuth, useUser } from '@clerk/clerk-react';
import '@mantine/core/styles.css';
import './index.css';
import { theme } from './theme';
import { App } from './App';
import { connect, setDeviceId, setTokenProvider } from './ws';
import { CLERK_ENABLED, CLERK_PUBLISHABLE_KEY, setOwnerId, setOwnerName } from './lib/clerk';
import {
  DEVICE_PAIRING_ENABLED,
  listDevices,
  setStorageTokenProvider,
  type Device,
} from './lib/storage';
import {
  ConnectMachine,
  ConnectMachineError,
  ConnectMachineLoading,
} from './components/ConnectMachine';

/** Remembers the chosen machine across reloads, so a multi-machine user lands back where they were. */
const DEVICE_STORAGE_KEY = 'lines.deviceId';

/**
 * Pick which machine to connect to. The stored choice wins while it still
 * exists; otherwise the most recently seen one, which is the best guess at
 * "the machine I am sitting at".
 */
function chooseDevice(devices: Device[]): Device | null {
  if (devices.length === 0) return null;
  const remembered = devices.find((d) => d.id === localStorage.getItem(DEVICE_STORAGE_KEY));
  if (remembered) return remembered;
  return [...devices].sort(
    (a, b) => new Date(b.lastSeenAt ?? 0).getTime() - new Date(a.lastSeenAt ?? 0).getTime(),
  )[0];
}

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
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    setDevices(null);
    listDevices()
      .then(setDevices)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(load, [load]);

  const chosen = devices ? chooseDevice(devices) : null;

  useEffect(() => {
    if (!chosen) return;
    localStorage.setItem(DEVICE_STORAGE_KEY, chosen.id);
    setDeviceId(chosen.id);
    void connect();
  }, [chosen]);

  if (error) return <ConnectMachineError error={error} onRetry={load} />;
  if (!devices) return <ConnectMachineLoading />;
  if (!chosen) return <ConnectMachine onPaired={load} />;
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
