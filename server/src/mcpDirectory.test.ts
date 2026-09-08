import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeConnection } from '@lines/shared';
import {
  directoryEntryFor,
  MCP_DIRECTORY,
  mcpConnectionHint,
  servicesNamedIn,
} from './mcpDirectory.ts';

/**
 * The nudge's whole justification is that it costs nothing on a turn it has no
 * business firing on, so precision is the property under test: prose that merely
 * contains a brand word matches nothing, and a service the user already has a
 * connection for is never mentioned.
 */

const NONE: { name: string; url?: string; enabled: boolean }[] = [];

test('every entry is shaped so prose cannot match it', () => {
  for (const entry of MCP_DIRECTORY) {
    assert.equal(entry.name, entry.name.toLowerCase(), entry.name);
    // A valid MCP namespace, since the nudge invites the agent to propose it.
    assert.ok(!('error' in normalizeConnection({ name: entry.name, transport: 'http', url: 'https://x.example/mcp' })), entry.name);
    assert.ok(entry.hosts.length > 0 && entry.endpointHosts.length > 0, entry.name);
    // Every host carries a TLD: that is what stops "linear algebra" matching.
    for (const host of [...entry.hosts, ...entry.endpointHosts]) {
      assert.match(host, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `${entry.name}: ${host}`);
    }
  }
  // No two entries claim one namespace.
  assert.equal(new Set(MCP_DIRECTORY.map((e) => e.name)).size, MCP_DIRECTORY.length);
});

test('a service is recognised from a URL, a bare domain and a subdomain', () => {
  for (const text of [
    'can you see this https://linear.app/acme/issue/NUR-4868/x',
    'check linear.app for the ticket',
    'the issue is on acme.linear.app',
    'mail from noreply@linear.app',
  ]) {
    assert.deepEqual(servicesNamedIn(text).map((e) => e.name), ['linear'], text);
  }
});

test('prose and lookalike domains match nothing', () => {
  for (const text of [
    'rewrite this with linear algebra',
    'a notion of scope',
    'the figma design',           // brand word without its domain
    'see notlinear.app/issue',    // different domain ending the same way
    'linear.apple.com is not it', // our host as a prefix of a longer one
    '',
  ]) {
    assert.deepEqual(servicesNamedIn(text), [], text);
  }
});

test('no hint when a connection already covers the service — by name or by host', () => {
  const text = 'read https://linear.app/x/issue/NUR-1';
  assert.equal(mcpConnectionHint(text, [{ name: 'linear', url: 'https://mcp.linear.app/mcp', enabled: true }]), null);
  // Named something else, but pointed at the vendor's host: still covered.
  assert.equal(mcpConnectionHint(text, [{ name: 'issues', url: 'https://mcp.linear.app/mcp', enabled: true }]), null);
  // A disabled row ships no tools, so the agent really does lack them.
  assert.ok(mcpConnectionHint(text, [{ name: 'linear', url: 'https://mcp.linear.app/mcp', enabled: false }]));
});

test('the hint names the vendor and the two tools, and never invents a URL', () => {
  const hint = mcpConnectionHint('see https://linear.app/x/issue/NUR-1', NONE);
  assert.ok(hint);
  assert.match(hint, /Linear/);
  assert.match(hint, /mcp__lines__add_mcp_connection/);
  assert.match(hint, /mcp__lines__authorize_mcp_connection/);
  // The endpoint is the agent's job to look up and cite; asserting one here
  // would put a URL this repo made up into the prompt.
  assert.ok(!/mcp\.linear\.app/.test(hint), 'no endpoint URL in the hint');
  assert.ok(!/https?:\/\//.test(hint), 'no URL at all in the hint');
});

test('an unmatched prompt carries nothing, and a crowded one stays short', () => {
  assert.equal(mcpConnectionHint('refactor the store', NONE), null);
  const many = mcpConnectionHint('linear.app, sentry.io, notion.so and asana.com', NONE);
  assert.ok(many);
  assert.match(many, /Linear and Sentry/);
  assert.ok(!/Notion/.test(many), 'capped at two vendors');
});

test('directory lookup goes both ways, and a subdomain of a documented host counts', () => {
  assert.equal(directoryEntryFor({ name: 'linear' })?.vendor, 'Linear');
  assert.equal(directoryEntryFor({ host: 'mcp.linear.app' })?.name, 'linear');
  assert.equal(directoryEntryFor({ host: 'eu.mcp.linear.app' })?.name, 'linear');
  assert.equal(directoryEntryFor({ host: 'notmcp.linear.app' }), undefined);
  assert.equal(directoryEntryFor({ name: 'acme-internal' }), undefined);
  assert.equal(directoryEntryFor({}), undefined);
});
