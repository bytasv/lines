import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RESERVED_MCP_SERVER_NAMES, normalizeConnection } from '@lines/shared';
import { McpConnections } from './mcpConnections.ts';
import { LINES_MCP_SERVER } from './mcpWorkflowTools.ts';
import { createStore } from './store.ts';

/**
 * The validator and the credential boundary.
 *
 * Assertions go through `serverConfigs()` — the real thing handed to the SDK —
 * rather than comparing strings, because that is the artifact whose shape
 * actually has to be right.
 */

function harness(seed: unknown[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-mcp-'));
  if (seed.length) fs.writeFileSync(path.join(root, 'mcp-connections.json'), JSON.stringify(seed));
  const store = createStore(root);
  return { root, store, mcp: new McpConnections(store) };
}

const HTTP = { name: 'figma', transport: 'http', url: 'https://mcp.figma.com/mcp' };

test('the reserved-name list matches the Lines server it exists to protect', () => {
  // The copy in shared/ cannot import the bridge module, so this is what stops
  // the two from drifting into a silently shadowed `mcp__lines__*` namespace.
  assert.ok(RESERVED_MCP_SERVER_NAMES.includes(LINES_MCP_SERVER));
});

test('a connection named after the Lines server is refused', () => {
  const h = harness();
  const result = h.mcp.add({ ...HTTP, name: LINES_MCP_SERVER });
  assert.deepEqual(result, { ok: false, reason: 'reserved-name' });
  assert.deepEqual(h.mcp.list(), []);
});

test('an http connection builds an http server config', () => {
  const h = harness();
  assert.equal(h.mcp.add(HTTP).ok, true);
  assert.deepEqual(h.mcp.serverConfigs(), {
    figma: { type: 'http', url: 'https://mcp.figma.com/mcp' },
  });
});

test('a stdio connection builds a stdio server config', () => {
  const h = harness();
  assert.equal(
    h.mcp.add({ name: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'srv'] }).ok,
    true,
  );
  assert.deepEqual(h.mcp.serverConfigs(), {
    local: { type: 'stdio', command: 'npx', args: ['-y', 'srv'] },
  });
});

test('alwaysLoad is never set, so tools defer behind tool search', () => {
  // Every enabled connection ships into every session; deferring is what keeps
  // that from costing context in sessions with nothing to do with it.
  const h = harness();
  h.mcp.add(HTTP);
  assert.equal('alwaysLoad' in (h.mcp.serverConfigs().figma as object), false);
});

test('a disabled connection is kept but ships no server config', () => {
  const h = harness();
  const added = h.mcp.add(HTTP);
  assert.equal(added.ok, true);
  const id = added.ok ? added.connection.id : '';
  h.mcp.update(id, { ...HTTP, enabled: false });
  assert.equal(h.mcp.list().length, 1);
  assert.deepEqual(h.mcp.serverConfigs(), {});
});

test('header values reach serverConfigs but never blob() or list()', () => {
  const h = harness();
  const added = h.mcp.add({ ...HTTP, headerKeys: ['Authorization'] }, { Authorization: 'Bearer sk-1' });
  assert.equal(added.ok, true);
  // The synced/broadcast form: names only.
  assert.deepEqual(h.mcp.blob().connections[0].headerKeys, ['Authorization']);
  assert.equal(JSON.stringify(h.mcp.blob()).includes('sk-1'), false);
  assert.equal(JSON.stringify(h.mcp.list()).includes('sk-1'), false);
  // The SDK-facing form: the value is attached exactly here.
  assert.deepEqual((h.mcp.serverConfigs().figma as { headers?: unknown }).headers, {
    Authorization: 'Bearer sk-1',
  });
});

test('a secret lives in its own file, not in the connections file', () => {
  const h = harness();
  h.mcp.add({ ...HTTP, headerKeys: ['Authorization'] }, { Authorization: 'Bearer sk-2' });
  const connections = fs.readFileSync(path.join(h.root, 'mcp-connections.json'), 'utf8');
  assert.equal(connections.includes('sk-2'), false);
  assert.equal(
    fs.readFileSync(path.join(h.root, 'mcp-secrets.json'), 'utf8').includes('sk-2'),
    true,
  );
});

test('dropping a header name drops its stored value', () => {
  const h = harness();
  const added = h.mcp.add({ ...HTTP, headerKeys: ['Authorization'] }, { Authorization: 'Bearer sk-3' });
  const id = added.ok ? added.connection.id : '';
  h.mcp.update(id, { ...HTTP, headerKeys: [] });
  assert.deepEqual(h.mcp.secretKeys(id), []);
  assert.equal('headers' in (h.mcp.serverConfigs().figma as object), false);
});

test('an update with no headers keeps the stored value', () => {
  // Editing a URL must not silently log the session out of the server.
  const h = harness();
  const added = h.mcp.add({ ...HTTP, headerKeys: ['Authorization'] }, { Authorization: 'Bearer sk-4' });
  const id = added.ok ? added.connection.id : '';
  h.mcp.update(id, { ...HTTP, headerKeys: ['Authorization'], url: 'https://mcp.figma.com/other' });
  assert.deepEqual(h.mcp.secretKeys(id), ['Authorization']);
});

test('removing a connection removes its secrets', () => {
  const h = harness();
  const added = h.mcp.add({ ...HTTP, headerKeys: ['Authorization'] }, { Authorization: 'Bearer sk-5' });
  const id = added.ok ? added.connection.id : '';
  assert.equal(h.mcp.remove(id), true);
  assert.deepEqual(h.mcp.secretKeys(id), []);
  assert.equal(fs.readFileSync(path.join(h.root, 'mcp-secrets.json'), 'utf8').includes('sk-5'), false);
});

test('a duplicate name is refused rather than shadowing the first row', () => {
  const h = harness();
  h.mcp.add(HTTP);
  assert.deepEqual(h.mcp.add({ ...HTTP, url: 'https://elsewhere.example/mcp' }), {
    ok: false,
    reason: 'duplicate-name',
  });
  assert.equal(h.mcp.list().length, 1);
});

test('updating a missing connection is refused', () => {
  const h = harness();
  assert.deepEqual(h.mcp.update('nope', HTTP), { ok: false, reason: 'not-found' });
});

test('the validator refuses shapes the SDK could not connect with', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ transport: 'http', url: 'https://x.example' }, 'empty-name'],
    [{ name: 'Bad Name', transport: 'http', url: 'https://x.example' }, 'bad-name'],
    [{ name: 'x', transport: 'carrier-pigeon' }, 'bad-transport'],
    [{ name: 'x', transport: 'http', url: 'not-a-url' }, 'bad-url'],
    [{ name: 'x', transport: 'http', url: 'file:///etc/passwd' }, 'bad-url'],
    [{ name: 'x', transport: 'stdio', command: '  ' }, 'empty-command'],
    [{ name: 'x', transport: 'http', url: 'https://x.example', headerKeys: ['bad header'] }, 'bad-header-name'],
    [{ name: 'x', transport: 'http', url: 'https://x.example', timeout: 5 }, 'bad-timeout'],
  ];
  for (const [input, expected] of cases) {
    const result = normalizeConnection(input);
    assert.deepEqual(result, { error: expected }, JSON.stringify(input));
  }
});

test('a name is trimmed and lowercased rather than refused', () => {
  const result = normalizeConnection({ name: '  Figma  ', transport: 'http', url: 'https://x.example' });
  assert.equal('connection' in result && result.connection.name, 'figma');
});

test('load-time migration rewrites junk once and is then idempotent', () => {
  const h = harness([
    HTTP,
    { name: 'lines', transport: 'http', url: 'https://evil.example/mcp' }, // reserved
    { name: 'figma', transport: 'http', url: 'https://dup.example/mcp' }, // duplicate name
    { nonsense: true },
  ]);
  assert.deepEqual(
    h.mcp.list().map((c) => c.name),
    ['figma'],
  );
  const after = fs.readFileSync(path.join(h.root, 'mcp-connections.json'), 'utf8');
  // A second construction over the cleaned file must not rewrite it.
  const reloaded = new McpConnections(createStore(h.root));
  assert.deepEqual(reloaded.list().map((c) => c.name), ['figma']);
  assert.equal(fs.readFileSync(path.join(h.root, 'mcp-connections.json'), 'utf8'), after);
});

test('connections survive a restart', () => {
  const h = harness();
  h.mcp.add(HTTP);
  const reloaded = new McpConnections(createStore(h.root));
  assert.deepEqual(reloaded.list().map((c) => c.name), ['figma']);
});

test('a fresh install stamps updatedAt so its row can win an LWW', () => {
  const h = harness();
  assert.ok(h.mcp.blob().updatedAt > 0);
});

test('a pending review read back from disk is sanitized before it reaches the wire', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-mcp-'));
  // reviewRemote sanitizes what it stages, but the staged blob round-trips through
  // a file only `updatedAt` is validated on — so this is the one path by which an
  // odd-shaped row reaches the review modal, which reads `.enabled` off each one.
  fs.writeFileSync(
    path.join(root, 'mcp-connections-sync.json'),
    JSON.stringify({
      updatedAt: 1,
      pending: {
        connections: [
          HTTP, // fine, but missing `enabled` — normalizeConnection fills it in
          { name: 'lines', transport: 'http', url: 'https://evil.example/mcp' }, // reserved
          { nonsense: true }, // no shape the SDK could connect with
        ],
        remoteUpdatedAt: 2,
        detectedAt: 3,
      },
      rejected: null,
    }),
  );
  const review = new McpConnections(createStore(root)).review();
  assert.deepEqual(review?.connections.map((c) => c.name), ['figma']);
  assert.equal(review?.connections[0].enabled, true);
  // The diff is recomputed off the sanitized list, so it cannot name a dropped row.
  assert.deepEqual(review?.added.map((c) => c.name), ['figma']);
  assert.equal(review?.detectedAt, 3);
});

/**
 * The codex translation.
 *
 * Same principle as the tests above: assert on `codexServerConfigs()`, the
 * artifact actually written into codex's `config.toml`, because its shape is
 * what codex parses. The expected shapes here were taken from `codex mcp add`
 * on 0.154.0, not from documentation.
 */

test('a stdio connection becomes a codex command server', () => {
  const h = harness();
  h.mcp.add({
    name: 'local',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'some-server'],
    env: { FOO: 'bar' },
  });
  const { servers, env, skipped } = h.mcp.codexServerConfigs();
  assert.deepEqual(servers, {
    local: { command: 'npx', args: ['-y', 'some-server'], env: { FOO: 'bar' } },
  });
  assert.deepEqual(env, {});
  assert.deepEqual(skipped, []);
});

test('the codex shape carries no `type` or `timeout` key', () => {
  // Codex infers the transport from which keys are present; a stray key makes it
  // reject the whole table, so the Claude-shaped extras must not leak through.
  const h = harness();
  h.mcp.add({ name: 'local', transport: 'stdio', command: 'npx', timeout: 5000 });
  const { servers } = h.mcp.codexServerConfigs();
  assert.deepEqual(Object.keys(servers.local as object), ['command']);
});

test('an http bearer token is passed by env-var name, never by value', () => {
  const h = harness();
  const added = h.mcp.add({ ...HTTP, headerKeys: ['Authorization'] }, { Authorization: 'Bearer sk-secret' });
  assert.ok(added.ok);
  const { servers, env } = h.mcp.codexServerConfigs();
  const config = servers.figma as Record<string, string>;
  assert.equal(config.url, 'https://mcp.figma.com/mcp');
  // The config is what lands on disk: it may name the variable and nothing more.
  assert.ok(!JSON.stringify(servers).includes('sk-secret'));
  assert.equal(env[config.bearer_token_env_var], 'Bearer sk-secret');
});

test('an http connection with a non-bearer header is skipped, with a reason', () => {
  // Codex models an HTTP credential as a bearer token only. Shipping this one
  // without its header would connect as the wrong principal.
  const h = harness();
  h.mcp.add({ ...HTTP, name: 'tenant', headerKeys: ['X-Api-Key'] }, { 'X-Api-Key': 'k' });
  const { servers, skipped } = h.mcp.codexServerConfigs();
  assert.deepEqual(servers, {});
  assert.deepEqual(skipped, [{ name: 'tenant', reason: 'headers-unsupported' }]);
});

test('an sse connection is skipped rather than handed over as streamable http', () => {
  const h = harness();
  h.mcp.add({ name: 'legacy', transport: 'sse', url: 'https://example.com/sse' });
  const { servers, skipped } = h.mcp.codexServerConfigs();
  assert.deepEqual(servers, {});
  assert.deepEqual(skipped, [{ name: 'legacy', reason: 'sse-unsupported' }]);
});

test('a disabled connection reaches codex no more than it reaches the SDK', () => {
  const h = harness();
  const added = h.mcp.add({ name: 'local', transport: 'stdio', command: 'npx' });
  assert.ok(added.ok);
  h.mcp.update(added.connection.id, { ...added.connection, enabled: false });
  assert.deepEqual(h.mcp.codexServerConfigs().servers, {});
});

test('the bearer env var is derived from the id, so a rename cannot orphan it', () => {
  const h = harness();
  const added = h.mcp.add({ ...HTTP, headerKeys: ['Authorization'] }, { Authorization: 'tok' });
  assert.ok(added.ok);
  const before = Object.keys(h.mcp.codexServerConfigs().env)[0];
  h.mcp.update(added.connection.id, { ...added.connection, name: 'figma-renamed' });
  assert.deepEqual(Object.keys(h.mcp.codexServerConfigs().env), [before]);
});
