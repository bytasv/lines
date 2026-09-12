import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * Canary for the `codex app-server` protocol, which the CLI marks experimental
 * and publishes no package for.
 *
 * Lines depends on a handful of method names and payload fields. They are not a
 * contract, so the defence is: vendor the CLI's own generated types
 * (`shared/codexProtocol`, see its README), and assert here that everything this
 * app reaches for still exists in them. Regenerating against a newer `codex` then
 * turns a protocol change into a failing test naming the missing method, instead
 * of a turn that parks or a card that never renders.
 *
 * Deliberately a *text* assertion over the generated files rather than a type
 * import: a renamed method is a changed string literal, which a type-level check
 * would not catch at all.
 */
const PROTOCOL_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'shared',
  'codexProtocol',
);

const read = (file: string) => fs.readFileSync(path.join(PROTOCOL_DIR, file), 'utf8');

/** Methods Lines calls today. Losing one breaks turns outright. */
const CLIENT_REQUESTS = [
  'initialize',
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/interrupt',
  // How the user's MCP connections reach a codex session. Lines never writes
  // `config.toml` itself, so losing this method loses the connections outright.
  'config/batchWrite',
];

/** Notifications Lines normalizes. Losing one silently drops part of a turn. */
const SERVER_NOTIFICATIONS = [
  'thread/started',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'thread/tokenUsage/updated',
];

/** Requests codex makes of *us*. Unwired today, but each one parks a turn when it
 *  arrives unanswered — so their names are what the next phase plugs into. */
const SERVER_REQUESTS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
  'item/tool/call',
];

test('every method Lines calls still exists in the generated protocol', () => {
  const source = read('ClientRequest.ts');
  for (const method of CLIENT_REQUESTS) {
    // `initialize` is the one that is not a slashed v2 path.
    if (method === 'initialize') continue;
    assert.ok(source.includes(`"${method}"`), `ClientRequest no longer declares ${method}`);
  }
});

test('every notification Lines normalizes still exists', () => {
  const source = read('ServerNotification.ts');
  for (const method of SERVER_NOTIFICATIONS) {
    assert.ok(source.includes(`"${method}"`), `ServerNotification no longer declares ${method}`);
  }
});

test('the approval requests the next phase needs still exist', () => {
  const source = read('ServerRequest.ts');
  for (const method of SERVER_REQUESTS) {
    assert.ok(source.includes(`"${method}"`), `ServerRequest no longer declares ${method}`);
  }
});

test('the item variants the normalizer maps still exist', () => {
  const source = read('v2/ThreadItem.ts');
  for (const variant of [
    'userMessage',
    'agentMessage',
    'reasoning',
    'commandExecution',
    'fileChange',
    'mcpToolCall',
  ]) {
    assert.ok(source.includes(`"type": "${variant}"`), `ThreadItem no longer has ${variant}`);
  }
});

test('the fields the normalizer reads off an item still exist', () => {
  const source = read('v2/ThreadItem.ts');
  // Renames here are the quiet kind: the item still maps, but its card renders
  // blank. camelCase is itself the v2 change that broke the exec-era names.
  for (const field of ['aggregatedOutput', 'exitCode', 'changes', 'summary']) {
    assert.ok(source.includes(field), `ThreadItem no longer carries ${field}`);
  }
});

test('token usage still breaks down the way spend accounting assumes', () => {
  const source = read('v2/TokenUsageBreakdown.ts');
  for (const field of [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    // Folded into output_tokens; losing it silently under-reports spend.
    'reasoningOutputTokens',
  ]) {
    assert.ok(source.includes(field), `TokenUsageBreakdown no longer carries ${field}`);
  }
});

test('turn status still distinguishes stopped from failed', () => {
  // The whole settle path keys off this: an interrupted turn must not render as
  // a failure with a Retry button.
  const source = read('v2/TurnStatus.ts');
  for (const status of ['completed', 'interrupted', 'failed']) {
    assert.ok(source.includes(`"${status}"`), `TurnStatus no longer has ${status}`);
  }
});

test('the sandbox modes the permission mapping targets still exist', () => {
  const source = read('v2/SandboxMode.ts');
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
    assert.ok(source.includes(`"${mode}"`), `SandboxMode no longer has ${mode}`);
  }
});

test('the config writer still takes the edit shape the MCP table is written with', () => {
  // `mcp_servers` is written as one whole-table `replace`, which is what makes a
  // removed connection actually go away. A lost `mergeStrategy` would silently
  // turn that into an append, leaving deleted servers configured.
  const params = read('v2/ConfigBatchWriteParams.ts');
  assert.ok(params.includes('edits'), 'ConfigBatchWriteParams no longer takes edits');
  assert.ok(params.includes('reloadUserConfig'), 'batchWrite no longer hot-reloads');
  const edit = read('v2/ConfigEdit.ts');
  for (const field of ['keyPath', 'value', 'mergeStrategy']) {
    assert.ok(edit.includes(field), `ConfigEdit no longer carries ${field}`);
  }
  assert.ok(read('v2/MergeStrategy.ts').includes('"replace"'), 'MergeStrategy lost replace');
});
