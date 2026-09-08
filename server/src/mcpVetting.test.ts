import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deterministicVerdict, parseVerdict, VETTING_TIMEOUT_MS, vetMcpUrl } from './mcpVetting.ts';

/**
 * Two properties, both load-bearing for the agent-proposal card:
 *
 *  - the mechanical refusals cost no model call, so a hostile URL is red even
 *    with no token, no network and no judge;
 *  - every judge failure reads `unknown` rather than throwing, because this runs
 *    on the path that raises the approval card and must never block it.
 */

/** A vendor the directory covers, so code alone can rule on it. */
const PROPOSAL = { name: 'linear', url: 'https://mcp.linear.app/mcp', source: 'https://linear.app/docs' };

/**
 * One it does not: an obscure vendor is the case the judge exists for, and the
 * case every judge-failure path has to answer `unknown` for.
 */
const UNLISTED = { name: 'acme', url: 'https://mcp.acme.example/mcp', source: 'https://acme.example/docs' };

/** A judge that must never be reached. */
const noJudge = async () => {
  throw new Error('the judge was called for a URL code could already rule on');
};

test('the mechanical checks are suspicious without asking a model anything', async () => {
  const cases: [string, string][] = [
    ['plain http', 'http://mcp.linear.app/mcp'],
    ['IP literal', 'https://203.0.113.4/mcp'],
    ['userinfo in the URL', 'https://user:pw@mcp.linear.app/mcp'],
    ['punycode host', 'https://xn--liner-9va.app/mcp'],
    ['credential in the query string', 'https://mcp.linear.app/mcp?access_token=abc'],
    ['not a URL at all', 'mcp.linear.app'],
  ];
  for (const [label, url] of cases) {
    const verdict = await vetMcpUrl({ ...PROPOSAL, url }, noJudge);
    assert.equal(verdict.level, 'suspicious', label);
    assert.ok(verdict.reason.length > 0, label);
    // The cited source rides along, so the card can show it whatever the level.
    assert.equal(verdict.source, PROPOSAL.source, label);
  }
});

test('a vendor in the directory is ruled on in code, not by the judge', async () => {
  // The documented host: `known` with no model call.
  const known = await vetMcpUrl(PROPOSAL, noJudge);
  assert.equal(known.level, 'known');
  assert.match(known.reason, /Linear's documented MCP host/);

  // The adversarial case the card exists for: our namespace, someone else's host.
  const squat = await vetMcpUrl({ ...PROPOSAL, url: 'https://linear-app.com/mcp' }, noJudge);
  assert.equal(squat.level, 'suspicious');
  assert.match(squat.reason, /mcp\.linear\.app, not on linear-app\.com/);
});

test('a vendor Lines does not know is left to the judge', () => {
  assert.equal(deterministicVerdict(UNLISTED), null);
});

test('the parser tolerates a chatty answer and rejects an unparseable one', () => {
  assert.deepEqual(parseVerdict('known: Linear’s documented MCP endpoint.'), {
    level: 'known',
    reason: 'Linear’s documented MCP endpoint.',
  });
  assert.deepEqual(parseVerdict("Here is my assessment.\nSUSPICIOUS - the domain imitates linear.app"), {
    level: 'suspicious',
    reason: 'the domain imitates linear.app',
  });
  assert.equal(parseVerdict('I am not able to help with that.'), null);
  assert.equal(parseVerdict(''), null);
  assert.equal(parseVerdict(null), null);
});

test('no judge, no answer, a thrown judge and a timeout all read unknown', async () => {
  const unchecked = { level: 'unknown', reason: 'Could not be checked.', source: UNLISTED.source };

  // No judge at all — the caller had no owner token to run one with.
  assert.deepEqual(await vetMcpUrl(UNLISTED), unchecked);
  // A judge that answers nothing (no result message came back).
  assert.deepEqual(await vetMcpUrl(UNLISTED, async () => null), unchecked);
  // A judge that answers something no level can be read out of.
  assert.deepEqual(await vetMcpUrl(UNLISTED, async () => 'no comment'), unchecked);
  // A judge that throws: the card must still be raised.
  assert.deepEqual(
    await vetMcpUrl(UNLISTED, async () => {
      throw new Error('spawn failed');
    }),
    unchecked,
  );
});

test('a judge that never answers is bounded, not awaited forever', async () => {
  // The real deadline is VETTING_TIMEOUT_MS; shortened here so the assertion is
  // about the bound existing rather than about waiting ten seconds for it.
  assert.equal(VETTING_TIMEOUT_MS, 10_000);
  // The deadline timer is `unref`'d (a pending vetting must not hold the bridge
  // open), and the judge here never settles — so without something ref'd the
  // event loop drains and the runner cancels this test instead of running it.
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    const verdict = await vetMcpUrl(UNLISTED, () => new Promise<string>(() => {}), 50);
    assert.deepEqual(verdict, { level: 'unknown', reason: 'Could not be checked.', source: UNLISTED.source });
  } finally {
    clearTimeout(keepAlive);
  }
});

test('a judge verdict is carried through with the cited source attached', async () => {
  const verdict = await vetMcpUrl(UNLISTED, async () => 'KNOWN: Acme publishes this endpoint.');
  assert.deepEqual(verdict, {
    level: 'known',
    reason: 'Acme publishes this endpoint.',
    source: UNLISTED.source,
  });
});

test('the judge is asked about the domain, and given no way to fetch it', async () => {
  let seen = '';
  let system = '';
  await vetMcpUrl({ name: 'acme', url: 'https://acme-app.example/mcp' }, async (prompt, systemPrompt) => {
    seen = prompt;
    system = systemPrompt;
    return 'suspicious: not a host Acme publishes from';
  });
  assert.ok(seen.includes('https://acme-app.example/mcp'), 'the URL is in the prompt');
  assert.ok(seen.includes('acme'), 'so is the claimed name');
  // The tool-free instruction is the mitigation for the injected-page case; the
  // caller's `allowedTools: []` is the enforcement.
  assert.ok(system.includes('no tools'));
});
