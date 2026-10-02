import React from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import '@mantine/core/styles.css';
import './index.css';
import { theme } from './theme';
import { LandingPage } from './components/LandingPage';

/**
 * Entry for the static marketing build served on the apex (web/vite.landing.config.ts).
 *
 * The apex is the relay's host, so by the origin-separation rule it must never
 * serve the app bundle: whatever runs there could otherwise reach the page that
 * holds the end-to-end encryption keys. This page holds none — no Clerk, no
 * router, no store, no socket — and its every action is a link to the app host.
 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <LandingPage appUrl={import.meta.env.VITE_APP_URL} />
    </MantineProvider>
  </React.StrictMode>,
);
