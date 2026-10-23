/**
 * The desktop app's local fallback window: the bundle built into `dist-local`
 * with `VITE_LINES_LOCAL_SHELL=1`, served on loopback by the shell when
 * linesapp.cloud is unreachable. It talks to this machine's bridge directly,
 * with no Clerk session and no storage URL.
 *
 * The bridge only takes that socket with this boot's runtime token (see
 * server/src/connectionPolicy.ts, `LINES_BRIDGE_DIRECT=token`). The shell hands
 * it over in the URL fragment, which no request carries; it is stashed and
 * stripped before anything else reads the URL, and leaves this page only as a
 * WebSocket subprotocol to the bridge itself.
 *
 * The window has no preload and no IPC, so everything it asks of the shell goes
 * to the shell's own loopback server under `/__shell/` — same origin, so the CSP
 * already allows it and no other page can read the answers.
 */
import { useEffect } from 'react';
import { useStore, readDraft } from '../store';
import { countRunning } from './alerts';

export const LOCAL_SHELL = import.meta.env.VITE_LINES_LOCAL_SHELL === '1';

/** Prefix of the subprotocol carrying the token. Mirrors BRIDGE_TOKEN_PROTOCOL_PREFIX in server/src/connectionPolicy.ts. */
const TOKEN_PROTOCOL_PREFIX = 'lines.bt.';
/** The subprotocol the bridge selects, so the token is never echoed back. */
const LINES_SUBPROTOCOL = 'lines';
/**
 * This tab only, so a reload still dials once the URL no longer carries it.
 * Rotates with the bridge: the shell reloads the window with a fresh fragment
 * whenever bridge.json changes.
 */
const TOKEN_KEY = 'lines.bridgeToken';

/**
 * Take `#bt=` off the URL into the stash, and strip it from the address before
 * anything can log, share or send the URL. Leaves the rest of the fragment
 * (`host=`) for its own readers. Call first thing at module load.
 */
export function stashBridgeTokenFromUrl(): void {
  if (!LOCAL_SHELL) return;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = params.get('bt');
  if (token === null) return;
  params.delete('bt');
  const rest = params.toString();
  history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`);
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* no storage: the next shell reload hands it over again */
  }
}

/** The subprotocols a direct socket offers: `lines` plus the token, in the local window only. */
export function bridgeTokenProtocols(): string[] | undefined {
  if (!LOCAL_SHELL) return undefined;
  let token: string | null = null;
  try {
    token = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    token = null;
  }
  return token ? [LINES_SUBPROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`] : undefined;
}

/**
 * Whether the shell's own relay link is up — the one sign the cloud is back that
 * this page cannot see for itself. Null when the shell did not answer.
 */
async function shellRelayUp(): Promise<boolean | null> {
  try {
    const res = await fetch('/__shell/status', { cache: 'no-store' });
    if (!res.ok) return null;
    const { relay } = (await res.json()) as { relay?: unknown };
    return relay === 'up';
  } catch {
    return null;
  }
}

/**
 * Leave the local window for the hosted app. Only meaningful in the local
 * shell; a no-op anywhere else. The shell decides where to go and checks the
 * hosted app answers first, so a cloud that is not back yet leaves this page in
 * place. The custom header makes a cross-site POST fail its preflight, so no
 * other page can flip the window.
 */
export function returnToCloud(): void {
  if (!LOCAL_SHELL) return;
  void fetch('/__shell/return', { method: 'POST', headers: { 'x-lines-shell': 'return' } }).catch(() => {
    /* the shell is this page's server: if it is gone, so is the window */
  });
}

/** How often the auto-return looks. */
const RETURN_POLL_MS = 5_000;
/** How long the cloud has to look healthy before the window goes back on its own. */
const RETURN_HYSTERESIS_MS = 60_000;

/**
 * Nothing the user would lose by the window navigating away: no turn running,
 * no unsent composer text (drafts live in this origin's storage, not the hosted
 * one's), no dialog open.
 */
function idle(): boolean {
  const { sessions } = useStore.getState();
  if (countRunning(sessions) > 0) return false;
  if (Object.keys(sessions).some((id) => readDraft(id).text.trim())) return false;
  return !document.querySelector('[role="dialog"]');
}

/**
 * Go back to the hosted app once the cloud has been healthy for a minute and
 * the user is between things. Healthy is the shell's relay link up *and* the
 * bridge's storage link answering: `signedOut` counts, since only the hosted
 * window can mint the fresh token that clears it. Otherwise the sync indicator
 * offers the same move by hand, through {@link returnToCloud}.
 *
 * Mount once, from the local window's root. Inert outside it.
 */
export function useAutoReturnToCloud(): void {
  useEffect(() => {
    if (!LOCAL_SHELL) return;
    let healthySince: number | null = null;
    let cancelled = false;
    const tick = async () => {
      const relayUp = await shellRelayUp();
      if (cancelled) return;
      const cloud = useStore.getState().storageStatus?.cloud;
      const healthy = relayUp === true && (cloud === 'ok' || cloud === 'signedOut');
      if (!healthy) {
        healthySince = null;
        return;
      }
      healthySince ??= Date.now();
      if (Date.now() - healthySince >= RETURN_HYSTERESIS_MS && idle()) {
        healthySince = null;
        returnToCloud();
      }
    };
    const timer = setInterval(() => void tick(), RETURN_POLL_MS);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
}
