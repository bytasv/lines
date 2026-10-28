import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extendVoiceLimit,
  transcribeBudgetMs,
  VOICE_INITIAL_SECONDS,
  VOICE_MAX_SECONDS,
  voiceLimitWarning,
} from '@lines/shared';

test('each extend adds two minutes, up to the ten-minute ceiling', () => {
  assert.equal(VOICE_INITIAL_SECONDS, 120);
  assert.equal(VOICE_MAX_SECONDS, 600);
  assert.equal(extendVoiceLimit(120), 240);
  assert.equal(extendVoiceLimit(240), 360);
  assert.equal(extendVoiceLimit(360), 480);
  assert.equal(extendVoiceLimit(480), 600);
  assert.equal(extendVoiceLimit(600), 600);
  assert.equal(extendVoiceLimit(540), 600);
});

test('the warning shows only in the last thirty seconds', () => {
  assert.equal(voiceLimitWarning(89_000, 120), null);
  assert.equal(voiceLimitWarning(90_000, 120), 30_000);
  assert.equal(voiceLimitWarning(119_000, 120), 1_000);
  assert.equal(voiceLimitWarning(125_000, 120), 0);
  // An extend pushes the window out with the limit.
  assert.equal(voiceLimitWarning(100_000, 240), null);
});

test('the transcribe budget is a base plus a second per second of audio', () => {
  assert.equal(transcribeBudgetMs(0), 120_000);
  assert.equal(transcribeBudgetMs(32_000 * 600), 720_000);
});
