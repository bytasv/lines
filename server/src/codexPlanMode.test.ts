import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CODEX_DEFAULT_MODE_PROMPT,
  CODEX_PLAN_MODE_PROMPT,
  codexModePrompt,
} from './codexPlanMode.ts';

/**
 * Plan mode on codex is carried by developer instructions, so these strings are
 * the feature. Each assertion here is a behaviour that was measured against the
 * live app-server, not a preference about wording.
 */

test('both prompts carry the mode tag codex keys mode changes off', () => {
  // Codex's own Default text: "Your active mode changes only when new developer
  // instructions with a different <collaboration_mode>...</collaboration_mode>
  // change it". Without the tag the text is just advice the model may ignore.
  assert.match(CODEX_PLAN_MODE_PROMPT, /<collaboration_mode>Plan<\/collaboration_mode>/);
  assert.match(CODEX_DEFAULT_MODE_PROMPT, /<collaboration_mode>Default<\/collaboration_mode>/);
});

test('each prompt stands the other one down', () => {
  // A mode stays active until different instructions replace it, and a resumed
  // thread carries its history — so each prompt has to say the other is over or a
  // session that planned once keeps refusing to edit forever.
  assert.match(CODEX_PLAN_MODE_PROMPT, /Default mode.{0,40}no longer active/s);
  assert.match(CODEX_DEFAULT_MODE_PROMPT, /Plan mode.{0,40}no longer active/s);
});

test('the plan prompt forbids writing but not reading', () => {
  // The measured difference: without these instructions the same prompt produced
  // three fileChange items; with them, zero. Investigation has to stay allowed or
  // the plan is uninformed.
  assert.match(CODEX_PLAN_MODE_PROMPT, /Do not edit, create or delete files/);
  assert.match(CODEX_PLAN_MODE_PROMPT, /encouraged/);
});

test('the plan prompt demands the plan as the final message', () => {
  // Load-bearing: codex emits no dedicated plan item, so Lines takes the turn's
  // last assistant message as the plan. A plan split across several messages
  // would lose all but the last.
  assert.match(CODEX_PLAN_MODE_PROMPT, /final message/);
});

test('the plan prompt does not ask the user whether to proceed', () => {
  // The approve/deny card is the question. A model that also asks in prose gets a
  // card and a question that contradict each other.
  assert.match(CODEX_PLAN_MODE_PROMPT, /do not ask whether to proceed/i);
});

test('an instruction-shaped request is still planned, not executed', () => {
  // "Add a --verbose flag" is phrased as a command; in plan mode it describes what
  // to plan. Without this the model reads the imperative and starts editing.
  assert.match(CODEX_PLAN_MODE_PROMPT, /even if the user's request is phrased as an instruction/);
});

test('the mode block is sent on every turn, in both directions', () => {
  assert.equal(codexModePrompt(true), CODEX_PLAN_MODE_PROMPT);
  // Not null: the Default block is what releases a session from a plan it entered
  // earlier in the same thread.
  assert.equal(codexModePrompt(false), CODEX_DEFAULT_MODE_PROMPT);
});
