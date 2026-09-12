import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askUserQuestionInput, userInputResponse } from './workerCodex.ts';

/**
 * Codex's `request_user_input` mapped onto Lines' `AskUserQuestion` card.
 *
 * Both directions are pure functions over the wire shapes, which is the whole
 * reason they are testable: the round trip has to survive codex keying questions
 * by id while Lines keys answers by question text.
 */

const params = {
  threadId: 'th1',
  turnId: 't1',
  itemId: 'i1',
  isBlocking: true,
  questions: [
    {
      id: 'q_abc',
      header: 'Scope',
      question: 'Which surface should the flag apply to?',
      isOther: true,
      isSecret: false,
      options: [
        { label: 'CLI only', description: 'Just the terminal entry point' },
        { label: 'CLI and app', description: 'Both' },
      ],
    },
  ],
};

test('a codex question becomes the card the Claude tool already renders', () => {
  const input = askUserQuestionInput(params) as {
    questions: { header: string; question: string; options: { label: string; description?: string }[] }[];
  };
  assert.equal(input.questions.length, 1);
  assert.equal(input.questions[0]!.header, 'Scope');
  assert.equal(input.questions[0]!.question, 'Which surface should the flag apply to?');
  assert.deepEqual(input.questions[0]!.options, [
    { label: 'CLI only', description: 'Just the terminal entry point' },
    { label: 'CLI and app', description: 'Both' },
  ]);
});

test('a free-text question maps with no options rather than being dropped', () => {
  // Codex sends `options: null` for a question with no fixed choices.
  const input = askUserQuestionInput({
    questions: [{ id: 'q1', header: 'Name', question: 'What should it be called?', options: null }],
  }) as { questions: { options: unknown[] }[] };
  assert.equal(input.questions.length, 1);
  assert.deepEqual(input.questions[0]!.options, []);
});

test("the answer is keyed back to codex's question id, not its text", () => {
  // The ids never leave the worker; Lines keys answers by question text because
  // that is what the Claude tool returns and what the transcript records.
  const out = userInputResponse(params, {
    'Which surface should the flag apply to?': 'CLI only',
  });
  assert.deepEqual(out, { answers: { q_abc: { answers: ['CLI only'] } } });
});

test('a multi-select answer is split back into separate choices', () => {
  // The card joins them with ', '; codex wants an array.
  const out = userInputResponse(params, {
    'Which surface should the flag apply to?': 'CLI only, CLI and app',
  });
  assert.deepEqual(out.answers.q_abc!.answers, ['CLI only', 'CLI and app']);
});

test('an unanswered question is absent, not answered empty', () => {
  // Codex's own guidance: "If request_user_input returns no answers, continue
  // with best judgment." An empty answer would instead assert the user chose
  // nothing, which is a different claim.
  assert.deepEqual(userInputResponse(params, {}), { answers: {} });
  assert.deepEqual(userInputResponse(params, undefined), { answers: {} });
});

test('an answer to a question codex did not ask is ignored', () => {
  const out = userInputResponse(params, { 'Some other question': 'yes' });
  assert.deepEqual(out, { answers: {} });
});
