import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

/**
 * People must never be coloured as agents.
 *
 * Colouring authorship only works if a human and an agent are distinguishable
 * before you read any label. If `personMeta` could return the main agent's blue
 * or a subagent's violet, that distinction silently stops holding and nothing
 * else in the UI would look wrong — so it is asserted here rather than left to
 * whoever next edits a palette.
 *
 * Read as source text, exactly as schema.credentials.test.ts reads the Prisma
 * schema: `agents.ts` pulls in JSX and cannot be imported from a node test, and
 * the invariant is about the two literal lists anyway.
 */

/** The person palette moved to identityRule.ts (kept JSX-free); agent colours stay in agents.ts. */
const PEOPLE_SOURCE = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/lib/identityRule.ts'),
  'utf8',
);
const AGENT_SOURCE = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/lib/agents.ts'),
  'utf8',
);

/** The colours on one `const NAME = [...]` / `= '...'` declaration. */
function colorsOf(source: string, declaration: RegExp): string[] {
  const match = declaration.exec(source);
  assert.ok(match, `could not find ${declaration} — did it get renamed?`);
  return [...match[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
}

describe('person vs agent colours', () => {
  test('the two palettes are disjoint', () => {
    const people = colorsOf(PEOPLE_SOURCE, /const PERSON_COLORS = \[([^\]]+)\]/);
    const agent = colorsOf(AGENT_SOURCE, /const AGENT_COLOR = ('[a-z]+')/);
    const mainAgent = colorsOf(AGENT_SOURCE, /MAIN_AGENT_META: AgentMeta = \{[^}]*color: ('[a-z]+')/);

    assert.ok(people.length >= 4, 'a handful of collaborators need a handful of colours');
    for (const reserved of [...agent, ...mainAgent]) {
      assert.ok(
        !people.includes(reserved),
        `${reserved} is an agent colour and must not be in PERSON_COLORS`,
      );
    }
  });

  test('personMeta exists and is deterministic by construction', () => {
    // A hash of the userId, not a counter or a random pick: the same person has to
    // be the same colour in every session and every tab, with nothing shared.
    assert.match(PEOPLE_SOURCE, /export function personMeta\(/);
    assert.doesNotMatch(
      PEOPLE_SOURCE.slice(PEOPLE_SOURCE.indexOf('export function personMeta(')),
      /Math\.random|Date\.now/,
      'personMeta must not depend on anything that varies between renders',
    );
  });
});

/**
 * Every path a *person's* prompt can take must carry an actor.
 *
 * The bug this exists to prevent: attribution was threaded through
 * `SessionManager.userPrompt`, but a workflow-attached session intercepts the
 * prompt earlier — `startIfPending` / `iterateIfWaiting` — and returns before
 * `userPrompt` is ever called. Most Lines sessions run a workflow, so in practice
 * *no* prompt was attributed, and the UI silently fell back to the host for
 * everybody's messages.
 *
 * Asserted against the source because the alternative is a live bridge with a
 * relay, a grant and two Clerk identities — which is exactly why this went
 * unnoticed by every other test.
 */
const INDEX = fs.readFileSync(path.resolve(import.meta.dirname, 'index.ts'), 'utf8');

describe('prompt paths carry an actor', () => {
  test('the actor is built unconditionally, not only for guests', () => {
    // Built for the owner too: otherwise a prompt's author is *inferred* by the
    // reader ("no actor means the host"), so the same message renders as two
    // different people depending on who is looking.
    const decl = /const actor: Actor = \{/.exec(INDEX);
    assert.ok(decl, 'handleMessage must build an actor for every connection');
    assert.doesNotMatch(
      INDEX,
      /const actor: Actor \| undefined/,
      'a conditional actor means owner-authored prompts record no author',
    );
  });

  test('every human-prompt entry point is passed the actor', () => {
    // One line per interceptor, in the order handleMessage tries them. A new one
    // added without `actor` fails here rather than silently dropping authorship.
    const entryPoints = [
      /workflows\.startIfPending\([^)]*actor\)/,
      /workflows\.iterateIfWaiting\([^)]*actor\)/,
      /sessions\.userPrompt\([\s\S]{0,200}?actor,/,
    ];
    for (const re of entryPoints) {
      assert.match(INDEX, re, `a prompt path is missing the actor: ${re}`);
    }
  });

  test('the workflow engine threads it down to the prompt call', () => {
    const WORKFLOWS = fs.readFileSync(path.resolve(import.meta.dirname, 'workflows.ts'), 'utf8');
    // iterateStep is the one that sends a person's literal text.
    assert.match(WORKFLOWS, /this\.sessions\.prompt\(sessionId, text, 'workflow', attachments, \[\], actor\)/);
  });
});
