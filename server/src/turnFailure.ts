/**
 * Turn failures the API names, and what the user can do about them here.
 *
 * A refused turn ends on a red banner carrying whatever the SDK/CLI said. For an
 * expired token that text is rewritten into an action (see `auth.ts` and
 * `SessionManager.recoverAuthFailure`); for everything else it used to fall
 * through raw — "output blocked by content filtering policy" plus a bare Retry,
 * with no hint that splitting the write, switching model or skipping the step
 * were all available in-session.
 *
 * This module is the classification half of that treatment for the four
 * non-auth failures worth naming. Same shape as `AUTH_FAILURE_PATTERNS`: narrow
 * patterns over error text that is not a published contract, so a wording change
 * degrades to today's behaviour (raw text + Retry) and never to worse. Banner
 * assembly stays in `sessions.ts`; only the matching lives here.
 */

/**
 * Which named failure a turn hit. Kept as its own type (rather than inlined into
 * `SessionErrorKind`) so the patterns and the advice can only be written for a
 * kind this module actually recognises.
 */
export type TurnFailureKind = 'filtered' | 'context' | 'invalid' | 'overloaded';

/**
 * Error text per kind, matched in order — first kind whose patterns hit wins, so
 * a message mentioning both a context overflow and a rate limit reads as the
 * context problem (the one the user has to fix; the other may be incidental).
 *
 * Deliberately narrow. A false positive costs a slightly wrong banner over a
 * still-working Retry, so digits (`400`, `429`, `529`) are anchored to the error
 * wording that surrounds them rather than matched alone.
 */
const TURN_FAILURE_PATTERNS: ReadonlyArray<readonly [TurnFailureKind, readonly RegExp[]]> = [
  [
    'filtered',
    [
      /unable to respond to this request/i,
      /usage polic(y|ies)/i,
      /output blocked/i,
      /content filtering polic/i,
      /stop_reason[^\n]*refusal/i,
      /\brefusal\b[^\n]*\bblocked\b/i,
      /\bblocked\b[^\n]*\brefusal\b/i,
    ],
  ],
  [
    'context',
    [
      /prompt is too long/i,
      /exceeds? the (maximum )?context/i,
      /context_length_exceeded/i,
      /too many tokens/i,
    ],
  ],
  ['invalid', [/invalid_request_error/i, /\b400\b[^\n]*bad request/i]],
  [
    'overloaded',
    [
      /overloaded_error/i,
      /rate_limit_error/i,
      // Anchored to the status text, so a tool output that merely contains the
      // digits ("exit code 429 lines written") is not a rate limit.
      /\b529\b[^\n]*\b(overloaded|service unavailable)\b/i,
      /\b429\b[^\n]*(rate limit|too many requests)/i,
    ],
  ],
];

/** The named failure this error text describes, or null to leave it raw. */
export function classifyTurnFailure(message: string): TurnFailureKind | null {
  for (const [kind, patterns] of TURN_FAILURE_PATTERNS) {
    if (patterns.some((re) => re.test(message))) return kind;
  }
  return null;
}

/**
 * What the banner says instead of the raw text. Every one of these names an
 * action available in this app right now, and by the time one is shown the app has
 * stopped acting on its own: 'overloaded' is re-driven transparently first and
 * only reaches a banner once its attempt budget is spent, and the other three are
 * deterministic and never re-driven (see the turn-recovery feature doc).
 *
 * Hard constraint, same as `authRecoveryMessage`: no string here may contain a
 * word that `classifyTurnFailure` or `isAuthFailureMessage` matches, or a
 * re-shown banner would classify itself. Covered by `turnFailure.test.ts`.
 */
const ADVICE: Record<TurnFailureKind, string> = {
  filtered:
    'The request was stopped before the model could answer — usually a large verbatim ' +
    'text block, not the task itself. Retry, ask for the text in smaller pieces or fetched ' +
    'from its source, or pick a different model in the composer.',
  context:
    "The prompt was larger than the model's context window. Retry after compacting, or " +
    'narrow what the step feeds in.',
  invalid:
    'The API rejected the request as malformed. Retry; if it repeats, change the prompt ' +
    'or the model.',
  overloaded: 'The API is busy or rate-limited right now. Wait a moment, then Retry.',
};

/** Only offered while a workflow step is parked — Approve is what skips it. */
const SKIP_SENTENCE = ' Or approve the step to skip it and do this part by hand.';

export function turnFailureAdvice(kind: TurnFailureKind, opts: { inWorkflow: boolean }): string {
  return ADVICE[kind] + (opts.inWorkflow ? SKIP_SENTENCE : '');
}

/**
 * One line appended to the re-sent prompt on Retry, for the two kinds where a
 * different phrasing is what changes the outcome. Null for everything else —
 * 'invalid' and 'overloaded' are not the prompt's fault, so re-sending it
 * verbatim is correct.
 *
 * Takes `SessionMeta.errorKind` as it stands (so `'auth'` and no kind at all
 * both fall through to null) because the single caller is
 * `SessionManager.lastPromptForRetry`, which reads that field directly.
 */
export function turnFailureRetryHint(kind: string | undefined): string | null {
  switch (kind) {
    case 'filtered':
      return (
        'The previous attempt was stopped before it could answer. Produce the same result ' +
        'without reproducing a long verbatim block — split it across separate writes, or fetch ' +
        'it from its canonical source instead of writing it out.'
      );
    case 'context':
      return (
        'The previous attempt was larger than the context window. Produce the same result ' +
        'while reading and writing less at once — work in smaller pieces.'
      );
    default:
      return null;
  }
}
