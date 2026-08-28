import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMPRESS_RESPONSES_PROMPT } from './caveman.ts';

/**
 * The prompt is a constant, so these guard the two edits that would quietly hurt:
 * trimming the safety carve-outs, and trimming it down to a one-liner the model
 * drifts out of a few turns in.
 */
test('the carve-outs that must never be compressed survive an edit', () => {
  for (const clause of [
    'Security warnings',
    'Irreversible action confirmations',
    'Multi-step sequences where fragment order or omitted conjunctions risk misread',
    'User asks to clarify or repeats question',
  ]) {
    assert.ok(COMPRESS_RESPONSES_PROMPT.includes(clause), `missing carve-out: ${clause}`);
  }
});

test('code, commits and PR text stay in normal prose', () => {
  assert.match(
    COMPRESS_RESPONSES_PROMPT,
    /Persisted outside chat: write normal prose code, comments, commits, docs, issue\/PR/,
  );
});

test('the ruleset says it stays active for the whole session', () => {
  assert.match(COMPRESS_RESPONSES_PROMPT, /## Persistence/);
  assert.match(
    COMPRESS_RESPONSES_PROMPT,
    /Default style for this whole session, every response\..*no filler drift/,
  );
});
