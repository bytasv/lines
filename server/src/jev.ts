/**
 * TypeSafe's JEV ("System One Model") as a per-turn router: given a routing rule
 * and one turn's prompt, which of the allowed models and efforts should it run on?
 *
 * Official API only (docs.typesafe.ai): `POST /v1/systemone`, bearer key, body
 * `{ model, state, questions }`, answers keyed by question id. The base URL is a
 * constant rather than env on purpose, so a config typo cannot route every
 * session's prompt text through somebody else's proxy.
 *
 * Deliberately sends only the turn's own prompt (capped) and a few plain-line
 * signals — never the transcript, never tool output. That bounds both what the
 * provider sees and what a prompt injection can steer; the pick is constrained
 * to the allowlist either way (see turnRouting.acceptPick).
 *
 * Never throws: a missing key, a non-2xx, a malformed body or a timeout all
 * answer null, and the turn runs on its current settings — the same contract as
 * runHelperQuery.
 */
import { DEFAULT_MODELS, REASONING_EFFORTS, type ReasoningEffort, type RoutingRule } from '@lines/shared';

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
/** JEV sits in front of every routed turn, so this is short — not the helper's 60s. */
export const JEV_TIMEOUT_MS = 1500;
/** Cap on the prompt text sent as `state`. */
export const JEV_MAX_PROMPT_CHARS = 4000;

const EFFORT_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  low: 'low — trivial follow-ups, small mechanical edits, quick lookups',
  medium: 'medium — ordinary focused tasks',
  high: 'high — multi-step changes that need care',
  xhigh: 'xhigh — hard problems, subtle bugs, cross-cutting changes',
  max: 'max — architecture, deep debugging, the hardest reasoning',
};

export interface DecideTurnInput {
  rule: RoutingRule;
  prompt: string;
  currentModel: string;
  currentEffort?: ReasoningEffort;
  source: 'user' | 'workflow';
  lastTurnFailed?: boolean;
  retryWithFeedback?: boolean;
  stepName?: string;
}

export interface JevDecision {
  model?: { id: string; confidence: number };
  effort?: { level: ReasoningEffort; confidence: number };
}

export interface JevDeps {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/** True when this bridge has a key, i.e. routing can call out at all. */
export function jevConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.TYPESAFE_API_KEY?.trim());
}

function stateText(input: DecideTurnInput): string {
  const prompt =
    input.prompt.length > JEV_MAX_PROMPT_CHARS
      ? `${input.prompt.slice(0, JEV_MAX_PROMPT_CHARS)}…`
      : input.prompt;
  const lines = [
    `current model: ${input.currentModel}`,
    `current effort: ${input.currentEffort ?? 'default'}`,
    `turn source: ${input.source}`,
    `last turn failed: ${input.lastTurnFailed ? 'yes' : 'no'}`,
    `retry with feedback: ${input.retryWithFeedback ? 'yes' : 'no'}`,
  ];
  if (input.stepName) lines.push(`workflow step: ${input.stepName}`);
  return `${lines.join('\n')}\n\nprompt:\n${prompt}`;
}

function modelDescription(id: string): string {
  const option = DEFAULT_MODELS.find((m) => m.id === id);
  if (!option) return id;
  return option.description ? `${option.label} — ${option.description}` : option.label;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * One JEV call for one turn, two questions evaluated in parallel: a `choice` for
 * the model and a `score` for the effort. Each comes back with its own
 * confidence, so the caller can gate them independently.
 */
export async function decideTurn(input: DecideTurnInput, deps: JevDeps = {}): Promise<JevDecision | null> {
  const env = deps.env ?? process.env;
  const key = env.TYPESAFE_API_KEY?.trim();
  if (!key) return null;
  const doFetch = deps.fetch ?? fetch;
  const { rule } = input;
  // Model ids carry dots and dashes; the option keys JEV answers with are safe
  // ids mapped back here.
  const modelIds = rule.models;
  const modelCriteria: Record<string, string> = {};
  modelIds.forEach((id, i) => (modelCriteria[`m${i}`] = modelDescription(id)));
  // Weakest first, so the score's index is the level.
  const efforts = REASONING_EFFORTS.filter((e) => rule.efforts.includes(e));

  const questions: Record<string, unknown> = {};
  if (modelIds.length > 1) {
    questions.model = {
      type: 'choice',
      instructions: `Which model should run this turn? Rule: ${rule.rule}`,
      criteria: modelCriteria,
    };
  }
  if (efforts.length > 1) {
    questions.effort = {
      type: 'score',
      instructions: `How much reasoning effort does this turn need? Rule: ${rule.rule}`,
      criteria: efforts.map((e) => EFFORT_DESCRIPTIONS[e] ?? e),
    };
  }
  if (Object.keys(questions).length === 0) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? JEV_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await doFetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.TYPESAFE_MODEL?.trim() || 'jev-latest',
        state: stateText(input),
        questions,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[jev] HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { answers?: Record<string, Record<string, unknown>> } | null;
    const answers = body?.answers;
    if (!answers || typeof answers !== 'object') return null;

    const out: JevDecision = {};
    const m = answers.model;
    if (m) {
      const choice = typeof m.choice === 'string' ? m.choice : undefined;
      const idx = choice && /^m\d+$/.test(choice) ? Number(choice.slice(1)) : -1;
      const confidence = num(m.confidence);
      if (idx >= 0 && idx < modelIds.length && confidence !== undefined) {
        out.model = { id: modelIds[idx], confidence };
      }
    }
    const e = answers.effort;
    if (e) {
      const score = num(e.score);
      const confidence = num(e.confidence);
      if (score !== undefined && confidence !== undefined) {
        const idx = Math.min(efforts.length - 1, Math.max(0, Math.round(score)));
        out.effort = { level: efforts[idx], confidence };
      }
    }
    return out.model || out.effort ? out : null;
  } catch (err) {
    console.warn('[jev]', err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}
