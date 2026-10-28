import type { ComponentType } from 'react';
import { useStore } from '../web/src/store';
import { useDevices } from '../web/src/lib/devices';
import {
  ALL_SESSIONS,
  ALL_TRANSCRIPTS,
  FIXTURE_DEVICES,
  FIXTURE_MODELS,
  OFFLINE_PROMPTS,
  SHELL_SESSIONS,
  SHELL_STATE,
  SHELL_TRANSCRIPTS,
} from './fixtures';

/**
 * The session surfaces read the session, its transcript and the model list from
 * the app's zustand store rather than from props. Seed it once, on import, with
 * a connected link and the fixture sessions — before anything subscribes, so no
 * component sees the half-empty boot state.
 *
 * The shell's state rides along: one machine linked and healthy (`machines`,
 * `primaryDeviceId`), the Lines project open, the idle session selected, plan
 * usage and who else is in the session. Page-wide facts a story wants different
 * (a dropped link, a storage outage) go in its `parameters.store`, which
 * kubi.config layers over this state for that instance only.
 */
const sessions = [...ALL_SESSIONS, ...SHELL_SESSIONS];
useStore.setState({
  connectionStatus: 'connected',
  bootstrapped: true,
  models: FIXTURE_MODELS,
  sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
  transcripts: { ...ALL_TRANSCRIPTS, ...SHELL_TRANSCRIPTS },
  // Every fixture session counts as loaded, so an empty one reads "send a
  // prompt" rather than "loading transcript" (SessionView asks the bridge otherwise).
  transcriptLoaded: Object.fromEntries(sessions.map((s) => [s.id, true])),
  queuedPrompts: OFFLINE_PROMPTS,
  ...(SHELL_STATE as Partial<ReturnType<typeof useStore.getState>>),
});

// Paired machines come from storage over HTTP, in a store of their own; there
// is no storage behind Kubi, so the list is fixed and a refresh does nothing.
useDevices.setState({ devices: FIXTURE_DEVICES, error: null, refresh: async () => {} });

/** Marks a definition as reading the seeded store; the seeding itself is the import. */
export const withSessionStore = (Story: ComponentType) => <Story />;

/** The composer and the rows above it sit in a 920px column in the app. */
export const withComposerColumn = (Story: ComponentType) => (
  <div style={{ maxWidth: 920, margin: '0 auto' }}>
    <Story />
  </div>
);

/** Transcript fills a flex column and scrolls inside it, so it needs a height. */
export const withTranscriptPane = (Story: ComponentType) => (
  <div style={{ height: 620, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
    <Story />
  </div>
);

/**
 * A browser window for the whole app. AppShell positions its header and navbar
 * `fixed`; the transform makes this box their containing block, so the shell
 * lays out inside it rather than against the editor's viewport.
 * `--lines-viewport` is what the main area sizes itself from (100dvh in the app).
 */
export const withAppWindow = (Story: ComponentType) => (
  <div
    style={
      {
        position: 'relative',
        width: 1280,
        height: 800,
        overflow: 'hidden',
        transform: 'translateZ(0)',
        margin: -16,
        '--lines-viewport': '800px',
      } as React.CSSProperties
    }
  >
    <Story />
  </div>
);

/*
 * The shell's columns size from `--kubi-window-width`, `--kubi-shell-height`
 * and `--kubi-main-width` where a captured page sets them (see kubi.config),
 * and from a 1280x800 window otherwise.
 */

/**
 * The 56px header bar. The status pills are `fixed` and centred on the
 * header's midline; contained here, they sit in a header-sized strip.
 */
export const withHeaderBar = (Story: ComponentType) => (
  <div
    style={{
      position: 'relative',
      width: 'var(--kubi-window-width, 1280px)',
      height: 56,
      transform: 'translateZ(0)',
      borderBottom: '1px solid var(--mantine-color-default-border)',
    }}
  >
    <Story />
  </div>
);

/** The navbar column: 280px by default, full height of the window under the header. */
export const withSidebarColumn = (Story: ComponentType) => (
  <div
    style={{
      width: 280,
      height: 'var(--kubi-shell-height, 744px)',
      display: 'flex',
      flexDirection: 'column',
      borderRight: '1px solid var(--mantine-color-default-border)',
    }}
  >
    <Story />
  </div>
);

/** The main area beside the sidebar, which SessionView fills. */
export const withMainArea = (Story: ComponentType) => (
  <div style={{ width: 'var(--kubi-main-width, 1000px)', height: 'var(--kubi-shell-height, 744px)' }}>
    <Story />
  </div>
);
