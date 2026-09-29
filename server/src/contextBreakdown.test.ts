import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MODELS, contextDenominator, preferContextSummary } from '@lines/shared';
import type { ContextSummary } from '@lines/shared';
import {
  normalizeContextBreakdown,
  normalizeName,
  sameContextSummary,
  sumNonDeferred,
  summarizeContextBreakdown,
} from './contextBreakdown.ts';

/** Shape of a healthy SDKControlGetContextUsageResponse, trimmed to what we read. */
const raw = () => ({
  categories: [
    { name: 'Messages', tokens: 57_600, color: 'claude' },
    { name: 'System tools', tokens: 17_900, color: 'blue' },
    { name: 'MCP tools', tokens: 8_300, color: 'cyan' },
    { name: 'MCP tools (deferred)', tokens: 20_500, color: 'gray', isDeferred: true },
    { name: 'Memory files', tokens: 264, color: 'orange' },
    { name: 'Custom agents', tokens: 0, color: 'grape' },
    { name: 'Free space', tokens: 906_700, color: 'text' },
  ],
  totalTokens: 84_064,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  percentage: 8.4,
  model: 'claude-opus-5-5',
  isAutoCompactEnabled: true,
  autoCompactThreshold: 920_000,
  mcpTools: [
    { name: 'search', serverName: 'pencil', tokens: 3_000, isLoaded: true },
    { name: 'design', serverName: 'other', tokens: 1_300, isLoaded: false },
    { name: 'open', serverName: 'pencil', tokens: 4_000, isLoaded: true },
  ],
  memoryFiles: [
    { path: '/repo/CLAUDE.md', type: 'Project', tokens: 200 },
    { path: '/home/u/.claude/CLAUDE.md', type: 'User', tokens: 64 },
  ],
  agents: [{ agentType: 'Explore', source: 'built-in', tokens: 368 }],
  systemTools: [{ name: 'Read', tokens: 900 }],
  systemPromptSections: [{ name: 'Tone', tokens: 400 }],
  deferredBuiltinTools: [{ name: 'WebFetch', tokens: 14_800, isLoaded: false }],
  skills: {
    totalSkills: 5,
    includedSkills: 2,
    tokens: 4_100,
    skillFrontmatter: [{ name: 'verify', source: 'project', tokens: 2_050 }],
  },
  slashCommands: { totalCommands: 30, includedCommands: 12, tokens: 1_200 },
  messageBreakdown: {
    toolCallTokens: 10_000,
    toolResultTokens: 30_000,
    attachmentTokens: 1_000,
    assistantMessageTokens: 9_000,
    userMessageTokens: 6_000,
    redirectedContextTokens: 600,
    unattributedTokens: 1_000,
  },
});

test('well-formed payload projects into the full breakdown', () => {
  const got = normalizeContextBreakdown(raw(), 1234);
  assert.ok(got);
  assert.equal(got.at, 1234);
  assert.equal(got.maxTokens, 1_000_000);
  assert.equal(got.totalTokens, 84_064);
  assert.equal(got.percentage, 8.4);
  assert.equal(got.autoCompactThreshold, 920_000);
  assert.equal(got.isAutoCompactEnabled, true);
  // Order preserved, zero rows kept at this stage, `color` dropped.
  assert.deepEqual(got.categories, [
    { name: 'Messages', tokens: 57_600 },
    { name: 'System tools', tokens: 17_900 },
    { name: 'MCP tools', tokens: 8_300 },
    { name: 'MCP tools (deferred)', tokens: 20_500, deferred: true },
    { name: 'Memory files', tokens: 264 },
    { name: 'Custom agents', tokens: 0 },
    { name: 'Free space', tokens: 906_700 },
  ]);
  assert.deepEqual(got.memoryFiles, [
    { path: '/repo/CLAUDE.md', type: 'Project', tokens: 200 },
    { path: '/home/u/.claude/CLAUDE.md', type: 'User', tokens: 64 },
  ]);
  assert.deepEqual(got.agents, [{ agentType: 'Explore', source: 'built-in', tokens: 368 }]);
  assert.deepEqual(got.systemTools, [{ name: 'Read', tokens: 900 }]);
  assert.deepEqual(got.systemPromptSections, [{ name: 'Tone', tokens: 400 }]);
  assert.deepEqual(got.deferredTools, [{ name: 'WebFetch', tokens: 14_800, loaded: false }]);
  assert.deepEqual(got.skills, {
    total: 5,
    included: 2,
    tokens: 4_100,
    items: [{ name: 'verify', source: 'project', tokens: 2_050 }],
  });
  assert.deepEqual(got.slashCommands, { total: 30, included: 12, tokens: 1_200 });
  assert.deepEqual(got.messages, {
    toolCalls: 10_000,
    toolResults: 30_000,
    attachments: 1_000,
    assistant: 9_000,
    user: 6_000,
    // redirected + unattributed, folded into one row.
    other: 1_600,
  });
});

test('mcp tools group by server: first-seen order, summed tokens, biggest tool first', () => {
  const got = normalizeContextBreakdown(raw(), 1);
  assert.deepEqual(got?.mcpServers, [
    {
      serverName: 'pencil',
      tokens: 7_000,
      toolCount: 2,
      tools: [
        { name: 'open', tokens: 4_000, loaded: true },
        { name: 'search', tokens: 3_000, loaded: true },
      ],
    },
    {
      serverName: 'other',
      tokens: 1_300,
      toolCount: 1,
      tools: [{ name: 'design', tokens: 1_300, loaded: false }],
    },
  ]);
});

test('deferred categories are excluded from the total, never double-counted', () => {
  const got = normalizeContextBreakdown(raw(), 1);
  assert.ok(got);
  const counted = got.categories.filter((c) => normalizeName(c.name) !== 'free space');
  assert.equal(sumNonDeferred(counted), got.totalTokens);
  assert.equal(got.categories.find((c) => c.name === 'MCP tools (deferred)')?.deferred, true);
});

test('older CLI payload: missing sections become empty or undefined, no throw', () => {
  const got = normalizeContextBreakdown(
    {
      categories: [{ name: 'Messages', tokens: 10 }],
      totalTokens: 10,
      maxTokens: 200_000,
      percentage: 0.005,
      model: 'claude-sonnet-5-5',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: false,
    },
    1,
  );
  assert.ok(got);
  assert.deepEqual(got.systemTools, []);
  assert.deepEqual(got.systemPromptSections, []);
  assert.deepEqual(got.deferredTools, []);
  assert.deepEqual(got.mcpServers, []);
  assert.equal(got.skills, undefined);
  assert.equal(got.slashCommands, undefined);
  assert.equal(got.messages, undefined);
  assert.equal(got.rawMaxTokens, undefined);
  assert.equal(got.autoCompactThreshold, undefined);
});

test('malformed payloads yield undefined rather than a partial reading', () => {
  assert.equal(normalizeContextBreakdown(undefined, 1), undefined);
  assert.equal(normalizeContextBreakdown(null, 1), undefined);
  assert.equal(normalizeContextBreakdown('nope', 1), undefined);
  assert.equal(normalizeContextBreakdown({}, 1), undefined);
  assert.equal(normalizeContextBreakdown({ categories: 'x', maxTokens: 100 }, 1), undefined);
  assert.equal(normalizeContextBreakdown({ categories: [], maxTokens: 'big' }, 1), undefined);
});

test('non-numeric token counts coerce to 0, never NaN', () => {
  const got = normalizeContextBreakdown(
    {
      maxTokens: 200_000,
      categories: [
        { name: 'Messages', tokens: null },
        { name: 'Skills', tokens: '12' },
        { name: 'Memory files', tokens: Number.NaN },
      ],
      mcpTools: [{ name: 'x', tokens: undefined }],
    },
    1,
  );
  assert.ok(got);
  assert.deepEqual(
    got.categories.map((c) => c.tokens),
    [0, 0, 0],
  );
  assert.equal(got.totalTokens, 0);
  assert.equal(got.percentage, 0);
  assert.equal(got.mcpServers[0].tokens, 0);
  assert.equal(got.mcpServers[0].serverName, '(unknown)');
  assert.equal(
    got.categories.some((c) => Number.isNaN(c.tokens)),
    false,
  );
});

test('summary drops detail, empty rows and free space, keeps deferred', () => {
  const full = normalizeContextBreakdown(raw(), 7)!;
  const summary = summarizeContextBreakdown(full);
  assert.deepEqual(Object.keys(summary).sort(), [
    'at',
    'autoCompactThreshold',
    'categories',
    'isAutoCompactEnabled',
    'maxTokens',
    'model',
    'percentage',
    'rawMaxTokens',
    'totalTokens',
  ]);
  assert.deepEqual(
    summary.categories.map((c) => c.name),
    ['Messages', 'System tools', 'MCP tools', 'MCP tools (deferred)', 'Memory files'],
  );
  // SessionMeta is persisted and synced — this guards against re-fattening it.
  assert.ok(JSON.stringify(summary).length < 2000);
});

test('sameContextSummary ignores the timestamp only', () => {
  const a = summarizeContextBreakdown(normalizeContextBreakdown(raw(), 1)!);
  const b = summarizeContextBreakdown(normalizeContextBreakdown(raw(), 999)!);
  assert.equal(sameContextSummary(a, b), true);
  assert.equal(sameContextSummary(a, { ...b, totalTokens: b.totalTokens + 1 }), false);
  assert.equal(sameContextSummary(undefined, undefined), true);
  assert.equal(sameContextSummary(a, undefined), false);
});

test('summary wins over the assistant-usage fallback unless the fallback is newer', () => {
  const summary = { at: 100 } as ContextSummary;
  assert.equal(preferContextSummary(summary, { at: 100 } as never), true);
  assert.equal(preferContextSummary(summary, { at: 101 } as never), false);
  assert.equal(preferContextSummary(summary, undefined), true);
  assert.equal(preferContextSummary(undefined, { at: 1 } as never), false);
});

test('the SDK window beats the hardcoded model table', () => {
  const summary = { maxTokens: 1_000_000 } as ContextSummary;
  assert.equal(contextDenominator(summary, 'claude-haiku-4-5', DEFAULT_MODELS), 1_000_000);
  assert.equal(contextDenominator(undefined, 'claude-haiku-4-5', DEFAULT_MODELS), 200_000);
  assert.equal(contextDenominator(undefined, 'some-future-model', DEFAULT_MODELS), undefined);
});
