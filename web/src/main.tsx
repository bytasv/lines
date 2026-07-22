import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MantineProvider } from '@mantine/core';
import { ClerkProvider, RedirectToSignIn, SignedIn, SignedOut, useAuth } from '@clerk/clerk-react';
import '@mantine/core/styles.css';
import './index.css';
import { theme } from './theme';
import { App } from './App';
import { connect, setTokenProvider } from './ws';
import { CLERK_ENABLED, CLERK_PUBLISHABLE_KEY } from './lib/clerk';

/** Rendered only when signed in: register the token source, then open the socket. */
function AuthedConnect() {
  const { getToken } = useAuth();
  useEffect(() => {
    setTokenProvider(() => getToken());
    void connect();
  }, [getToken]);
  return <App />;
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
