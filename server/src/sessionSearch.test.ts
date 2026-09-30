import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TranscriptEvent } from '@lines/shared';
import { buildMatcher, clipAround } from '@lines/shared';
import { searchableTexts, searchSession } from './sessionSearch.ts';

let seq = 0;
const ev = (kind: TranscriptEvent['kind'], data: unknown): TranscriptEvent => ({
  seq: ++seq,
  ts: seq,
  kind,
  data,
});

const assistant = (content: unknown[]) => ev('sdk', { type: 'assistant', message: { content } });

const events: TranscriptEvent[] = [
  ev('user', { text: 'please fix the flaky widget test' }),
  ev('sdk', { type: 'system', subtype: 'init', model: 'x widget' }),
  assistant([
    { type: 'thinking', thinking: 'the widget is secretly fine' },
    { type: 'text', text: 'Looking at the widget now.' },
    { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test widget', timeout: 5 } },
  ]),
  ev('sdk', {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'widget: 1 failing' }] },
  }),
  ev('interject', { text: 'also check the widget docs' }),
  // Everything inside a compaction span is invisible to every scan.
  ev('context-compact', { phase: 'requested' }),
  ev('sdk', { type: 'assistant', message: { content: [{ type: 'text', text: 'widget summary' }] } }),
  ev('context-compact', { phase: 'done' }),
  // A provider switch's seed prompt is folded into its marker, not a prompt.
  ev('provider-switch', { from: 'a', to: 'b' }),
  ev('user', { text: 'handoff summary about the widget' }),
  assistant([{ type: 'text', text: 'Understood, the widget.' }]),
];

test('extracts prompts, agent text, tool inputs and results — and nothing else', () => {
  const texts = searchableTexts(events).map((t) => [t.seq, t.text, t.toolUseId ?? null]);
  assert.deepEqual(texts, [
    [1, 'please fix the flaky widget test', null],
    [3, 'Looking at the widget now.', null],
    [3, 'npm test widget', 'tool-1'],
    [4, 'widget: 1 failing', 'tool-1'],
    [5, 'also check the widget docs', null],
    [11, 'Understood, the widget.', null],
  ]);
});

test('searchSession returns the matching seq and the match offsets', () => {
  const hit = searchSession('s1', events, buildMatcher('widget'), 50);
  assert.equal(hit?.sessionId, 's1');
  assert.deepEqual(
    hit?.matches.map((m) => m.seq),
    [1, 3, 3, 4, 5, 11],
  );
  const first = hit!.matches[0];
  assert.equal(first.text.slice(first.start, first.end), 'widget');
  assert.equal(hit!.matches[2].toolUseId, 'tool-1');
});

test('searchSession respects the per-session limit, and null means no match', () => {
  assert.equal(searchSession('s1', events, buildMatcher('widget'), 2)?.matches.length, 2);
  assert.equal(searchSession('s1', events, buildMatcher('secretly'), 50), null);
});

test('searchSession trims indentation and keeps offsets right', () => {
  const hit = searchSession('s', [ev('user', { text: '    indented widget' })], buildMatcher('widget'), 5);
  const m = hit!.matches[0];
  assert.equal(m.text, 'indented widget');
  assert.equal(m.text.slice(m.start, m.end), 'widget');
});

test('buildMatcher: literal, case, word and regex semantics', () => {
  assert.deepEqual(buildMatcher('a.b')('a.b axb'), [[0, 3]]);
  assert.deepEqual(buildMatcher('Foo')('foo FOO'), [
    [0, 3],
    [4, 7],
  ]);
  assert.deepEqual(buildMatcher('Foo', { caseSensitive: true })('foo Foo'), [[4, 7]]);
  assert.deepEqual(buildMatcher('foo', { wholeWord: true })('foobar foo'), [[7, 10]]);
  assert.deepEqual(buildMatcher('fo+', { regex: true })('fooo f'), [[0, 4]]);
  // Zero-length matches are skipped rather than looping.
  assert.deepEqual(buildMatcher('x*', { regex: true })('ab'), []);
  assert.deepEqual(buildMatcher('')('anything'), []);
  assert.throws(() => buildMatcher('(', { regex: true }), SyntaxError);
});

test('clipAround keeps short lines whole and centres long ones on the match', () => {
  assert.deepEqual(clipAround('short line', 0, 5), { text: 'short line', start: 0, end: 5 });
  const line = `${'a'.repeat(300)}MATCH${'b'.repeat(300)}`;
  const clip = clipAround(line, 300, 305, 50);
  assert.equal(clip.text.slice(clip.start, clip.end), 'MATCH');
  assert.ok(clip.text.startsWith('…') && clip.text.endsWith('…'));
  const tail = clipAround(line, line.length - 5, line.length, 50);
  assert.equal(tail.text.slice(tail.start, tail.end), 'bbbbb');
  assert.ok(!tail.text.endsWith('…'));
});
