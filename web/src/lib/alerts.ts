import type { SessionMeta, SessionStatus } from '@claude-ui/shared';
import logoUrl from '../assets/logo.svg';

const ALERTS_KEY = 'claude-ui.alerts';
const ALERT_SOUND_KEY = 'claude-ui.alertSound';

const ALERT_STATUSES: SessionStatus[] = ['done', 'waiting-permission', 'waiting-approval'];

export type AlertSound =
  | 'chime'
  | 'ping'
  | 'blip'
  | 'rise'
  | 'alarm'
  | 'knock'
  | 'droplet'
  | 'marimba'
  | 'breath'
  | 'pulse'
  | 'siren'
  | 'buzzer'
  | 'arcade'
  | 'triplet';

interface SoundSpec {
  wave: OscillatorType;
  /** Peak gain (0-1). Higher = louder. */
  gain: number;
  /** Notes played back to back: [frequency Hz, duration seconds]. */
  notes: Array<[number, number]>;
}

const SOUNDS: Record<AlertSound, SoundSpec> = {
  // Bright triangle bell, two clear notes.
  chime: { wave: 'triangle', gain: 0.5, notes: [[988, 0.18], [740, 0.22]] },
  // Single loud high tone.
  ping: { wave: 'triangle', gain: 0.55, notes: [[1319, 0.22]] },
  // Punchy double square blip.
  blip: { wave: 'square', gain: 0.4, notes: [[660, 0.09], [660, 0.09]] },
  // Ascending triad fanfare.
  rise: { wave: 'sawtooth', gain: 0.4, notes: [[523, 0.12], [659, 0.12], [880, 0.2]] },
  // Insistent repeating two-tone alarm.
  alarm: { wave: 'square', gain: 0.45, notes: [[880, 0.14], [660, 0.14], [880, 0.14], [660, 0.18]] },
  // Low double knock.
  knock: { wave: 'sine', gain: 0.6, notes: [[196, 0.12], [196, 0.14]] },

  // --- Soft ---
  // Single gentle high sine drop.
  droplet: { wave: 'sine', gain: 0.3, notes: [[1175, 0.16]] },
  // Warm mellow two-note fall.
  marimba: { wave: 'sine', gain: 0.35, notes: [[784, 0.16], [523, 0.24]] },
  // Very soft low breath.
  breath: { wave: 'sine', gain: 0.25, notes: [[330, 0.3]] },
  // Subtle triangle heartbeat.
  pulse: { wave: 'triangle', gain: 0.3, notes: [[440, 0.1], [440, 0.16]] },

  // --- Intense ---
  // Wailing two-tone siren, several sweeps.
  siren: {
    wave: 'sawtooth',
    gain: 0.5,
    notes: [[784, 0.16], [988, 0.16], [784, 0.16], [988, 0.16], [784, 0.2]],
  },
  // Harsh low square buzzer.
  buzzer: { wave: 'square', gain: 0.55, notes: [[147, 0.22], [147, 0.26]] },
  // Fast rising arcade run.
  arcade: {
    wave: 'square',
    gain: 0.45,
    notes: [[523, 0.07], [659, 0.07], [784, 0.07], [1046, 0.16]],
  },
  // Three sharp escalating beeps.
  triplet: { wave: 'square', gain: 0.5, notes: [[880, 0.1], [1046, 0.1], [1319, 0.18]] },
};

export const ALERT_SOUND_OPTIONS: Array<{
  group: string;
  items: Array<{ value: AlertSound; label: string }>;
}> = [
  {
    group: 'Standard',
    items: [
      { value: 'chime', label: 'Chime' },
      { value: 'ping', label: 'Ping' },
      { value: 'blip', label: 'Blip' },
      { value: 'rise', label: 'Rise' },
      { value: 'knock', label: 'Knock' },
    ],
  },
  {
    group: 'Soft',
    items: [
      { value: 'droplet', label: 'Droplet' },
      { value: 'marimba', label: 'Marimba' },
      { value: 'breath', label: 'Breath' },
      { value: 'pulse', label: 'Pulse' },
    ],
  },
  {
    group: 'Intense',
    items: [
      { value: 'alarm', label: 'Alarm' },
      { value: 'siren', label: 'Siren' },
      { value: 'buzzer', label: 'Buzzer' },
      { value: 'arcade', label: 'Arcade' },
      { value: 'triplet', label: 'Triplet' },
    ],
  },
];

export function loadAlertSound(): AlertSound {
  const raw = localStorage.getItem(ALERT_SOUND_KEY);
  return raw && raw in SOUNDS ? (raw as AlertSound) : 'chime';
}

export function persistAlertSound(sound: AlertSound): void {
  localStorage.setItem(ALERT_SOUND_KEY, sound);
}

const STATUS_BODY: Partial<Record<SessionStatus, string>> = {
  done: 'Task complete',
  'waiting-permission': 'Needs permission',
  'waiting-approval': 'Needs approval',
};

export function loadAlertsEnabled(): boolean {
  return localStorage.getItem(ALERTS_KEY) === 'on';
}

export function persistAlertsEnabled(on: boolean): void {
  if (on) localStorage.setItem(ALERTS_KEY, 'on');
  else localStorage.removeItem(ALERTS_KEY);
}

let audioCtx: AudioContext | null = null;

/** Create/resume the AudioContext from a user gesture so autoplay policy is satisfied. */
export function primeAudio(): void {
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  } catch {
    // ignore
  }
}

export function playSound(sound: AlertSound): void {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume();
    if (audioCtx.state === 'suspended') return;
  }
  const ctx = audioCtx;
  const spec = SOUNDS[sound];
  let start = ctx.currentTime;
  for (const [freq, dur] of spec.notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = spec.wave;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(spec.gain, start + 0.01);
    // Hold near peak, then quick decay so it stays audible but doesn't click.
    gain.gain.setValueAtTime(spec.gain, start + dur * 0.6);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur);
    start += dur;
  }
}

export async function requestNotifyPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied';
  if (Notification.permission === 'default') {
    try {
      return await Notification.requestPermission();
    } catch {
      return Notification.permission;
    }
  }
  return Notification.permission;
}

function notify(session: SessionMeta, onClick: () => void): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const body = STATUS_BODY[session.status];
  if (!body) return;
  try {
    const n = new Notification(session.name, {
      body,
      tag: session.id,
      icon: logoUrl,
    });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    // ignore
  }
}

/** Sessions that are finished or blocked on the user — what the badge counts. */
export function countAttention(sessions: Record<string, SessionMeta>): number {
  let n = 0;
  for (const s of Object.values(sessions)) {
    if (!s.archived && ALERT_STATUSES.includes(s.status)) n++;
  }
  return n;
}

/** Sessions actively running — drives the favicon's blue "in progress" dot. */
export function countRunning(sessions: Record<string, SessionMeta>): number {
  let n = 0;
  for (const s of Object.values(sessions)) {
    if (!s.archived && s.status === 'running') n++;
  }
  return n;
}

const BASE_TITLE = document.title;

/** Reflect the count of sessions needing attention on the app/dock icon and tab title. */
export function setBadge(count: number): void {
  try {
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (count > 0) void nav.setAppBadge?.(count);
    else void nav.clearAppBadge?.();
  } catch {
    // ignore
  }
  document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
}

interface AlertOpts {
  enabled: boolean;
  sound: AlertSound;
  selectedSessionId: string | null;
  onClickNotification: () => void;
}

export function maybeAlert(
  prev: SessionMeta | undefined,
  next: SessionMeta,
  opts: AlertOpts,
): void {
  if (!opts.enabled) return;
  if (!prev || prev.status === next.status) return;
  if (!ALERT_STATUSES.includes(next.status)) return;
  if (next.archived) return;
  // User is already looking at this session.
  if (document.hasFocus() && opts.selectedSessionId === next.id) return;
  playSound(opts.sound);
  notify(next, opts.onClickNotification);
}
