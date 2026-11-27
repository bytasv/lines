import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  humanizeToolName,
  mcpGroupKey,
  mcpProvider,
  mcpToolTitle,
  parseMcpToolName,
} from '../../web/src/lib/mcpTools.ts';

/**
 * MCP tool name formatting (web/src/lib/mcpTools.ts), tested from the server's
 * runner because that is the only test runner this repo has.
 */

describe('parseMcpToolName', () => {
  test('splits server and tool', () => {
    assert.deepEqual(parseMcpToolName('mcp__linear__create_issue'), { server: 'linear', tool: 'create_issue' });
  });

  test('a single underscore stays in the server name', () => {
    assert.deepEqual(parseMcpToolName('mcp__my_tracker__list'), { server: 'my_tracker', tool: 'list' });
  });

  test('the server ends at the first double underscore; the tool keeps the rest', () => {
    assert.deepEqual(parseMcpToolName('mcp__github__repos__list'), { server: 'github', tool: 'repos__list' });
  });

  test('connector-prefixed servers parse whole', () => {
    assert.deepEqual(parseMcpToolName('mcp__claude_ai_Linear__get_issue'), {
      server: 'claude_ai_Linear',
      tool: 'get_issue',
    });
  });

  test('non-MCP names are null', () => {
    assert.equal(parseMcpToolName('Bash'), null);
    assert.equal(parseMcpToolName('mcp__linear'), null);
    assert.equal(parseMcpToolName('mcp__linear__'), null);
    assert.equal(parseMcpToolName('mcp____tool'), null);
  });
});

describe('humanizeToolName', () => {
  test('snake, kebab and camel case read as a sentence', () => {
    assert.equal(humanizeToolName('get_runtime_logs'), 'Get runtime logs');
    assert.equal(humanizeToolName('get-runtime-logs'), 'Get runtime logs');
    assert.equal(humanizeToolName('getRuntimeLogs'), 'Get runtime logs');
  });

  test('acronyms keep their case', () => {
    assert.equal(humanizeToolName('list_PRs'), 'List PRs');
    assert.equal(humanizeToolName('getHTTPStatus'), 'Get HTTP status');
  });
});

describe('mcpProvider', () => {
  test('known vendors get their label and glyph', () => {
    const p = mcpProvider('vercel');
    assert.equal(p.label, 'Vercel');
    assert.equal(p.icon, 'vercel');
  });

  test('a connector prefix is stripped before lookup', () => {
    assert.equal(mcpProvider('claude_ai_Linear').label, 'Linear');
  });

  test('unknown servers fall back to a title-cased label, a monogram and a stable colour', () => {
    const p = mcpProvider('acme_tracker');
    assert.equal(p.label, 'Acme tracker');
    assert.equal(p.icon, undefined);
    assert.equal(p.monogram, 'AT');
    assert.equal(mcpProvider('acme_tracker').color, p.color);
    assert.match(p.color, /^hsl\(/);
  });

  test('title and group key', () => {
    assert.equal(mcpToolTitle('mcp__linear__create_issue'), 'Linear · Create issue');
    assert.equal(mcpToolTitle('Read'), null);
    assert.deepEqual(mcpGroupKey('mcp__figma__get_screenshot'), {
      key: 'mcp:figma',
      server: 'figma',
      label: 'Figma',
    });
    assert.deepEqual(mcpGroupKey('Read'), { key: 'Read', label: 'Read' });
  });
});
