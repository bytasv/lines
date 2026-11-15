/**
 * Prompts whose bytes are still leaving the browser. A big attachment over a
 * relay link can take many seconds to upload, and before this nothing was
 * visible between Send clearing the composer and the bridge echoing the message.
 *
 * Pure transitions over the store's `sendingPrompts` map, so the lifecycle is
 * testable without a socket:
 *   encrypting -> sending (progress 0..1) -> sent -> removed
 *   encrypting|sending -> failed -> removed (the prompt is restored to the draft)
 *
 * "Sent" means the bytes left this browser (`bufferedAmount` drained), not that
 * the bridge has them. A sent row is cleared by the first sign the bridge does:
 * a transcript event or a queue change for that session, or a timeout.
 */

export type SendingPhase = 'encrypting' | 'sending' | 'sent' | 'failed';

export interface SendingPrompt {
  id: string;
  text: string;
  attachmentCount: number;
  /** Size of the serialised frame, in bytes. */
  bytes: number;
  /** 0..1 share of `bytes` that has left the browser. */
  progress: number;
  phase: SendingPhase;
}

export type SendingPrompts = Record<string, SendingPrompt[]>;

function updateRow(
  map: SendingPrompts,
  sessionId: string,
  id: string,
  patch: (row: SendingPrompt) => SendingPrompt,
): SendingPrompts {
  const rows = map[sessionId];
  if (!rows?.some((r) => r.id === id)) return map;
  return { ...map, [sessionId]: rows.map((r) => (r.id === id ? patch(r) : r)) };
}

function withRows(map: SendingPrompts, sessionId: string, rows: SendingPrompt[]): SendingPrompts {
  if (rows.length) return { ...map, [sessionId]: rows };
  const next = { ...map };
  delete next[sessionId];
  return next;
}

export function startSending(
  map: SendingPrompts,
  sessionId: string,
  row: Omit<SendingPrompt, 'progress' | 'phase'>,
): SendingPrompts {
  return { ...map, [sessionId]: [...(map[sessionId] ?? []), { ...row, progress: 0, phase: 'encrypting' }] };
}

export function progressSending(
  map: SendingPrompts,
  sessionId: string,
  id: string,
  progress: number,
  phase: 'encrypting' | 'sending',
): SendingPrompts {
  const clamped = Math.max(0, Math.min(1, progress));
  return updateRow(map, sessionId, id, (r) =>
    // Only live rows move; a late poll must not resurrect a finished one.
    r.phase === 'encrypting' || r.phase === 'sending' ? { ...r, progress: clamped, phase } : r,
  );
}

export function finishSending(map: SendingPrompts, sessionId: string, id: string): SendingPrompts {
  return updateRow(map, sessionId, id, (r) => (r.phase === 'failed' ? r : { ...r, progress: 1, phase: 'sent' }));
}

export function failSending(map: SendingPrompts, sessionId: string, id: string): SendingPrompts {
  return updateRow(map, sessionId, id, (r) => (r.phase === 'sent' ? r : { ...r, phase: 'failed' }));
}

export function removeSending(map: SendingPrompts, sessionId: string, id: string): SendingPrompts {
  const rows = map[sessionId];
  if (!rows?.some((r) => r.id === id)) return map;
  return withRows(map, sessionId, rows.filter((r) => r.id !== id));
}

/** The bridge answered for this session: every row already sent has arrived. Live rows stay. */
export function clearSent(map: SendingPrompts, sessionId: string): SendingPrompts {
  const rows = map[sessionId];
  if (!rows?.some((r) => r.phase === 'sent')) return map;
  return withRows(map, sessionId, rows.filter((r) => r.phase !== 'sent'));
}
