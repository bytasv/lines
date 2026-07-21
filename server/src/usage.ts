/**
 * Polls Claude-plan usage (the same 5-hour / weekly windows shown by Claude
 * Code's `/usage`) and broadcasts snapshots to browsers.
 *
 * Auth reuses the Claude Code login: we read that CLI's OAuth access token
 * (macOS Keychain, falling back to ~/.claude/.credentials.json) and call the
 * official usage endpoint. No refresh-token flow — an expired token just 401s
 * and the chip goes away until the user next runs the CLI, which refreshes the
 * stored token itself. API-key users (no OAuth creds) get no chip at all.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerMessage, UsageSnapshot, UsageWindow } from '@claude-ui/shared';

const execFileAsync = promisify(execFile);

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');

const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes, like ClaudeUsageBar
const REFRESH_DEBOUNCE_MS = 5_000; // coalesce bursts of turn-complete refreshes
const REFRESH_MIN_SPACING_MS = 30_000; // never hit the endpoint more than this often
const FETCH_TIMEOUT_MS = 10_000;
const MAX_FAILURES = 3; // consecutive failures before hiding a stale snapshot

/** Read the Claude Code OAuth access token, or null if unavailable. */
async function readAccessToken(): Promise<string | null> {
  let raw: string | null = null;
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-w',
      ]);
      raw = stdout;
    } catch {
      raw = null;
    }
  }
  if (raw == null) {
    try {
      raw = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    } catch {
      return null;
    }
  }
  try {
    const token = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } })?.claudeAiOauth
      ?.accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Known window keys in display order; the parser also picks up unknown ones defensively. */
const KNOWN_WINDOWS = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus'];

/** Extract usage windows tolerantly, surviving additive shape drift. Throws if none parse. */
function parseSnapshot(body: unknown): UsageSnapshot {
  if (!body || typeof body !== 'object') throw new Error('usage response not an object');
  const record = body as Record<string, unknown>;
  const seen = new Set<string>();
  const windows: UsageWindow[] = [];
  const consider = (id: string) => {
    if (seen.has(id)) return;
    const val = record[id];
    if (!val || typeof val !== 'object') return;
    const util = (val as { utilization?: unknown }).utilization;
    if (typeof util !== 'number') return;
    const resets = (val as { resets_at?: unknown }).resets_at;
    seen.add(id);
    windows.push({
      id,
      utilization: util,
      resetsAt: typeof resets === 'string' ? resets : null,
    });
  };
  for (const id of KNOWN_WINDOWS) consider(id);
  for (const id of Object.keys(record)) consider(id);
  if (windows.length === 0) throw new Error('no usage windows in response');
  return { windows, fetchedAt: Date.now() };
}

export class UsagePoller {
  private snapshotValue: UsageSnapshot | null = null;
  private failures = 0;
  private inFlight = false;
  private lastFetchAt = 0;
  private available: boolean | null = null; // for logging state transitions only
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(private broadcast: (msg: ServerMessage) => void) {}

  get snapshot(): UsageSnapshot | null {
    return this.snapshotValue;
  }

  start(): void {
    void this.fetch();
    setInterval(() => void this.fetch(), POLL_INTERVAL_MS).unref();
  }

  /** Request a refresh soon (after an SDK result), debounced and rate-limited. */
  refreshSoon(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (Date.now() - this.lastFetchAt < REFRESH_MIN_SPACING_MS) return;
      void this.fetch();
    }, REFRESH_DEBOUNCE_MS);
    this.debounceTimer.unref();
  }

  private async fetch(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    this.lastFetchAt = Date.now();
    try {
      const token = await readAccessToken();
      if (!token) throw new Error('no OAuth credentials');
      const res = await fetch(USAGE_URL, {
        headers: { authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`usage endpoint ${res.status}`);
      const snapshot = parseSnapshot(await res.json());
      this.failures = 0;
      this.snapshotValue = snapshot;
      this.setAvailable(true);
      this.broadcast({ type: 'usage', usage: snapshot });
    } catch (err) {
      this.failures++;
      this.setAvailable(false, err);
      // Keep a stale snapshot through transient blips; hide it once clearly broken.
      if (this.snapshotValue && this.failures >= MAX_FAILURES) {
        this.snapshotValue = null;
        this.broadcast({ type: 'usage', usage: null });
      }
    } finally {
      this.inFlight = false;
    }
  }

  /** Log only on availability transitions, so a no-creds machine stays quiet. */
  private setAvailable(ok: boolean, err?: unknown): void {
    if (this.available === ok) return;
    this.available = ok;
    if (ok) console.log('[usage] plan usage available');
    else console.warn('[usage] unavailable:', err instanceof Error ? err.message : String(err));
  }
}
