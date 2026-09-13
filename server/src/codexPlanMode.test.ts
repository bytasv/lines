import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CodexAppServer } from './codexAppServer.ts';
import { CODEX_PLAN_FALLBACK_EFFORT, codexCollaborationMode } from './codexPlanMode.ts';
import { applyModePreset, resetModePresets } from './workerCodex.ts';

/**
 * The collaboration-mode seam, both halves of it.
 *
 * It holds the least obvious rule in the codex integration: `reasoning_effort:
 * null` is read *literally* by codex, not as "use the preset". A plan turn sent
 * with null asked 0 clarifying questions and emitted 0 plan items — plan mode in
 * name only — while 'medium' gave 2 and 1. So the bridge's null means "the worker
 * fills this", and a null must never survive as far as `turn/start`.
 */

/** A `collaborationMode/list` answer, in the envelope the app-server returns. */
function appServer(rows: { mode: string; reasoning_effort: string | null }[] | null): CodexAppServer {
  return {
    request: async (method: string) => {
      assert.equal(method, 'collaborationMode/list');
      if (!rows) throw new Error('experimental API not enabled');
      return { data: rows };
    },
  } as unknown as CodexAppServer;
}

const PRESETS = [
  { mode: 'plan', reasoning_effort: 'medium' },
  { mode: 'default', reasoning_effort: null },
];

test('plan mode maps to codex’s own plan mode, and anything else to default', () => {
  assert.equal(codexCollaborationMode(true, 'gpt-5.6-terra').mode, 'plan');
  assert.equal(codexCollaborationMode(false, 'gpt-5.6-terra').mode, 'default');
});

test('no chosen effort leaves reasoning_effort null for the worker to fill', () => {
  const mode = codexCollaborationMode(false, 'gpt-5.6-terra');
  assert.deepEqual(mode.settings, {
    model: 'gpt-5.6-terra',
    reasoning_effort: null,
    developer_instructions: null,
  });
});

test('a chosen effort rides the collaboration mode verbatim', () => {
  assert.equal(codexCollaborationMode(false, 'gpt-5.6-terra', 'high').settings.reasoning_effort, 'high');
  assert.equal(codexCollaborationMode(true, 'gpt-5.6-terra', 'xhigh').settings.reasoning_effort, 'xhigh');
});

test('the model is always a string, since codex rejects a null one', () => {
  // "invalid type: null, expected a string" is how the field was found at all.
  assert.equal(typeof codexCollaborationMode(true, 'gpt-5.6-terra').settings.model, 'string');
});

test('applyModePreset passes a chosen effort through untouched', async () => {
  resetModePresets();
  const mode = codexCollaborationMode(true, 'gpt-5.6-terra', 'xhigh');
  const applied = await applyModePreset(appServer(PRESETS), mode);
  // Not the Plan preset's 'medium': the user asked for something else.
  assert.equal(applied.settings.reasoning_effort, 'xhigh');
});

test('applyModePreset fills a null from codex’s own preset', async () => {
  resetModePresets();
  const applied = await applyModePreset(appServer(PRESETS), codexCollaborationMode(true, 'gpt-5.6-terra'));
  assert.equal(applied.settings.reasoning_effort, 'medium');
});

test('a failed collaborationMode/list still keeps plan mode off null', async () => {
  resetModePresets();
  const plan = await applyModePreset(appServer(null), codexCollaborationMode(true, 'gpt-5.6-terra'));
  assert.equal(plan.settings.reasoning_effort, CODEX_PLAN_FALLBACK_EFFORT);

  resetModePresets();
  // Default mode has no preset worth guessing: null here is codex's own default
  // effort, which is what an ordinary turn ran at before any of this existed.
  const ordinary = await applyModePreset(appServer(null), codexCollaborationMode(false, 'gpt-5.6-terra'));
  assert.equal(ordinary.settings.reasoning_effort, null);
});
