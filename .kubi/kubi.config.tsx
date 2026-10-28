import '@mantine/core/styles.css';
import '../web/src/index.css';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { createTheme, MantineProvider, mergeThemeOverrides } from '@mantine/core';
import { MemoryRouter } from 'react-router-dom';
import { theme } from '../web/src/theme';
import { SESSION_SORT_KEY } from '../web/src/lib/format';
import { AccountOverride } from './mocks/clerk';
import { StoreOverrides } from './mocks/store';
import * as pageLinesTest from './scenarios/page-lines-test';
import * as page17919581889488394 from './scenarios/page-17919581889488394';
import * as page17919650064905394 from './scenarios/page-17919650064905394';
import * as capture1791980722496 from './scenarios/capture-1791980722496';
// Settings › Updates reads __LINES_VERSION__ while it renders.
import './mocks/viteDefines';

/** The sidebar's "show archived" toggle, a `useLocalStorage` key like the sort. */
const SHOW_ARCHIVED_KEY = 'lines.showArchived';

/** Captured pages, by the scenario Kubi names their islands with. */
const SCENARIOS: Record<
  string,
  {
    store: Record<string, unknown>;
    sessionSort?: string;
    /** Whether the sidebar's archived group was unfolded on the page. */
    showArchived?: boolean;
    account?: { imageUrl?: string; alt?: string };
    /** The page's window, as the CSS variables ./decorators sizes the shell from. */
    layout?: Record<string, string>;
  }
> = {
  'page-lines-test': pageLinesTest,
  'page-17919581889488394': page17919581889488394,
  'page-17919650064905394': page17919650064905394,
  'capture-1791980722496': capture1791980722496,
};

/**
 * The sidebar keeps its sort order (and whether the archived group is open) in
 * localStorage (`useLocalStorage`), and on mount re-broadcasts what it read to
 * every other sidebar on the window. Holding a scenario's values means: write
 * them before the island's effects read them, swallow that broadcast, then put
 * the stored values back once they have run — so they reach this island alone
 * and nothing persists.
 */
let heldStorage: { previous: Record<string, string | null>; block: (e: Event) => void } | null = null;

function holdStorage(values: Record<string, unknown>) {
  if (heldStorage) return;
  const keys = Object.keys(values);
  const previous = Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)]));
  const block = (e: Event) => {
    const key = (e as CustomEvent<{ key?: string }>).detail?.key;
    if (key && keys.includes(key)) e.stopImmediatePropagation();
  };
  window.addEventListener('mantine-local-storage', block, true);
  for (const key of keys) localStorage.setItem(key, JSON.stringify(values[key]));
  heldStorage = { previous, block };
}

function releaseStorage() {
  if (!heldStorage) return;
  window.removeEventListener('mantine-local-storage', heldStorage.block, true);
  for (const [key, value] of Object.entries(heldStorage.previous)) {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
  heldStorage = null;
}

function StorageOverride({ values, children }: { values: Record<string, unknown>; children?: ReactNode }) {
  // Before the first render's child effects; a parent's effects run after its children's.
  useState(() => holdStorage(values));
  useEffect(() => {
    releaseStorage();
    // A StrictMode remount re-runs the children's effects before this one again.
    return () => {
      holdStorage(values);
      queueMicrotask(releaseStorage);
    };
  }, [values]);
  return <>{children}</>;
}

/** The sidebar's localStorage values a scenario names, or null when it names none. */
function scenarioStorage(scenario: { sessionSort?: string; showArchived?: boolean }) {
  const values: Record<string, unknown> = {};
  if (scenario.sessionSort) values[SESSION_SORT_KEY] = scenario.sessionSort;
  if (scenario.showArchived !== undefined) values[SHOW_ARCHIVED_KEY] = scenario.showArchived;
  return Object.keys(values).length ? values : null;
}

/** Per scenario, so the hold's effect sees one stable object across renders. */
const STORAGE = Object.fromEntries(
  Object.entries(SCENARIOS).map(([name, scenario]) => [name, scenarioStorage(scenario)]),
);

/**
 * Mantine writes its theme variables for `:root` by default, which does not
 * match inside Kubi's shadow root. Scope them to a wrapper class instead, and
 * give that wrapper (and Kubi's popup/modal containers) the dark-scheme
 * attribute the app sets on <html> (main.tsx renders with defaultColorScheme="dark").
 */
const SCOPE = 'kubi-mantine-root';

function scopeContainer(el: unknown) {
  if (!(el instanceof HTMLElement)) return;
  el.classList.add(SCOPE);
  el.setAttribute('data-mantine-color-scheme', 'dark');
}

export default {
  mocks: {
    '@clerk/clerk-react': './mocks/clerk',
    '../web/src/components/MonacoDiffModal': './mocks/monacoDiffModal',
    '../web/src/ws': './mocks/ws',
    '../web/src/store': './mocks/store',
    '../web/src/lib/clerk': './mocks/clerkConfig',
    '../web/src/lib/shares': './mocks/shares',
    '../web/src/lib/monacoSetup': './mocks/monacoSetup',
    '../web/src/lib/whatsNew': './mocks/whatsNew',
  },
  decorators: [
    (Story: React.ComponentType, context: { kubi?: { portalContainer?: HTMLElement; modalContainer?: HTMLElement } }) => {
      const kubi = context.kubi ?? {};
      scopeContainer(kubi.portalContainer);
      scopeContainer(kubi.modalContainer);
      const scoped = mergeThemeOverrides(
        theme,
        createTheme({
          components: {
            Portal: { defaultProps: { target: kubi.portalContainer } },
            Modal: { defaultProps: { portalProps: { target: kubi.modalContainer } } },
            Drawer: { defaultProps: { portalProps: { target: kubi.modalContainer } } },
          },
        }),
      );
      return (
        <MantineProvider
          theme={scoped}
          forceColorScheme="dark"
          cssVariablesSelector={`.${SCOPE}`}
          deduplicateCssVariables={false}
          getRootElement={() => undefined}
        >
          <div
            className={SCOPE}
            data-mantine-color-scheme="dark"
            style={{
              background: 'var(--mantine-color-body)',
              color: 'var(--mantine-color-text)',
              fontFamily: 'var(--mantine-font-family)',
              fontSize: 'var(--mantine-font-size-md)',
              // index.css sets these on :root, which does not match inside the
              // shadow root; without them every calc() that uses one is invalid.
              ['--lines-safe-top' as string]: '0px',
              ['--lines-keyboard' as string]: '0px',
            }}
          >
            <Story />
          </div>
        </MantineProvider>
      );
    },
    /**
     * The app's routes and links (react-router-dom v7) need a router. A story
     * names the URL it renders at with `parameters.router.initialEntries`, e.g.
     * `['/session/<id>']` for the shell with that session open.
     */
    (Story: ComponentType, context: { parameters?: { router?: { initialEntries?: string[] } } }) => (
      <MemoryRouter initialEntries={context.parameters?.router?.initialEntries ?? ['/']}>
        <Story />
      </MemoryRouter>
    ),
    /**
     * `parameters.store` patches the app store for this instance only (see
     * mocks/store): a story can drop the link or fail storage without taking
     * every other component on the canvas down with it.
     */
    (Story: ComponentType, context: { parameters?: { store?: Record<string, unknown> } }) =>
      context.parameters?.store ? (
        <StoreOverrides value={context.parameters.store}>
          <Story />
        </StoreOverrides>
      ) : (
        <Story />
      ),
    /**
     * A captured page's islands carry its scenario: its store fields, account and
     * sidebar order (see ./scenarios) apply to those islands only.
     */
    (Story: ComponentType, context: { kubi?: { scenario?: string } }) => {
      const name = context.kubi?.scenario;
      const scenario = name ? SCENARIOS[name] : undefined;
      if (!name || !scenario) return <Story />;
      const storage = STORAGE[name];
      let node = (
        <StoreOverrides value={scenario.store}>
          <Story />
        </StoreOverrides>
      );
      if (scenario.account) node = <AccountOverride value={scenario.account}>{node}</AccountOverride>;
      if (storage) node = <StorageOverride values={storage}>{node}</StorageOverride>;
      if (scenario.layout) node = <div style={{ display: 'contents', ...scenario.layout }}>{node}</div>;
      return node;
    },
  ],
  parameters: {},
};
