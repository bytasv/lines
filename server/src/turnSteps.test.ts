import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { foldAgentTurns, groupTally, type ToolBlock, type TranscriptItem } from '../../web/src/lib/transcript.ts';
import { narrationLabel, taskCarries, turnSteps, type TurnStep } from '../../web/src/lib/turnSteps.ts';

/**
 * The Compact-level turn checklist's step inference (web/src/lib/turnSteps.ts),
 * tested from the server's runner because that is the only test runner this repo has.
 */

function say(key: string, text: string): TranscriptItem {
  return { kind: 'assistant', key, blocks: [{ type: 'text', text }] } as TranscriptItem;
}

function think(key: string): TranscriptItem {
  return { kind: 'assistant', key, blocks: [{ type: 'thinking', text: 'hmm' }] } as TranscriptItem;
}

function tool(id: string, name: string, input: Record<string, unknown>, extra: Partial<ToolBlock> = {}): ToolBlock {
  return { type: 'tool', id, name, input, result: 'ok', ...extra };
}

function group(...tools: ToolBlock[]): TranscriptItem {
  return { kind: 'tool-group', key: `g${tools[0].id}`, tools };
}

function result(key: string, isError: boolean): TranscriptItem {
  return { kind: 'result', key, isError, stopped: false, recovering: false } as TranscriptItem;
}

function steps(items: TranscriptItem[], live = false): TurnStep[] {
  return turnSteps(items, live).filter((e): e is TurnStep => e.kind === 'step');
}

describe('turnSteps', () => {
  test('narration and the tools after it are one step', () => {
    const items = [
      say('a1', 'Let me read the config loader to see how defaults merge.'),
      group(tool('t1', 'Read', { file_path: '/x/config.ts' }), tool('t2', 'Grep', { pattern: 'merge' })),
    ];
    const out = steps(items);
    assert.equal(out.length, 1);
    assert.equal(out[0].label, 'Read the config loader to see how defaults merge');
    assert.equal(out[0].items.length, 2);
    assert.equal(out[0].tools.length, 2);
    assert.equal(out[0].status, 'done');
  });

  test('tools with no narration before them get a label from the tool summary', () => {
    const out = steps([group(tool('t1', 'Bash', { command: 'npm test' }))]);
    assert.equal(out.length, 1);
    assert.equal(out[0].label, 'Bash npm test');
  });

  test('silent tool calls are a step each; narration absorbs the calls after it', () => {
    const out = steps([
      group(tool('t1', 'Read', { file_path: '/a' })),
      think('a2'),
      group(tool('t3', 'Grep', { pattern: 'x' })),
      say('a4', 'Now check the build script for the flag.'),
      group(tool('t5', 'Read', { file_path: '/b' })),
      group(tool('t6', 'Bash', { command: 'npm run build' })),
    ]);
    assert.deepEqual(
      out.map((s) => s.key),
      ['gt1', 'a2', 'a4'],
    );
    assert.equal(out[1].label, 'Search for x');
    assert.equal(out[2].tools.length, 2);
  });

  test('a merged silent group splits into runs of the same tool; a narrated one stays whole', () => {
    const silent = steps([
      group(
        tool('t1', 'Read', { file_path: '/a' }),
        tool('t2', 'Read', { file_path: '/b' }),
        tool('t3', 'Grep', { pattern: 'x' }),
        tool('t4', 'Bash', { command: 'ls' }),
      ),
    ]);
    assert.deepEqual(
      silent.map((s) => [s.key, s.tools.length]),
      [
        ['gt1', 2],
        ['gt3', 1],
        ['gt4', 1],
      ],
    );
    // A rebuild over the same tool blocks hands back the same sub-group objects.
    const blocks = [tool('t1', 'Read', {}), tool('t2', 'Grep', {})];
    const first = steps([group(...blocks)]);
    const second = steps([group(...blocks)]);
    assert.equal(first[0].items[0], second[0].items[0]);
    assert.equal(first[1].items[0], second[1].items[0]);

    const narrated = steps([
      say('a0', 'Read both config files and search them.'),
      group(tool('t1', 'Read', { file_path: '/a' }), tool('t3', 'Grep', { pattern: 'x' })),
    ]);
    assert.equal(narrated.length, 1);
    assert.equal(narrated[0].tools.length, 2);
  });

  test('thin narration loses to the tool summary', () => {
    const out = steps([say('a1', 'Now let me check.'), group(tool('t1', 'Read', { file_path: '/x/a.ts' }))]);
    assert.equal(out[0].label, 'Read a.ts');
  });

  test('a call with a description is labelled by it; file and search tools read as phrases', () => {
    const out = steps([
      group(tool('t1', 'Bash', { command: 'git ls-files | wc -l', description: 'count tracked files' })),
      think('a2'),
      group(tool('t3', 'Grep', { pattern: 'turnSteps' })),
      think('a4'),
      group(tool('t5', 'Edit', { file_path: '/repo/web/src/index.css', old_string: 'a', new_string: 'b' })),
    ]);
    assert.deepEqual(
      out.map((s) => s.label),
      ['Count tracked files', 'Search for turnSteps', 'Edit index.css'],
    );
  });

  test('a subagent spawn is labelled by its description', () => {
    const out = steps([
      think('a1'),
      group(tool('t1', 'Agent', { description: 'Survey the auth code', prompt: 'Look at…' })),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].label, 'Survey the auth code');
  });

  test('a failed tool fails its step', () => {
    const out = steps([say('a1', 'Run the unit tests for the server.'), group(tool('t1', 'Bash', { command: 'x' }, { isError: true }))]);
    assert.equal(out[0].status, 'failed');
  });

  test('the last step of a live turn is active; not live, it is done', () => {
    const items = [
      say('a1', 'Read the config loader first.'),
      group(tool('t1', 'Read', { file_path: '/a' })),
      say('a2', 'Then update the default values.'),
      group(tool('t2', 'Edit', { file_path: '/a', old_string: 'a', new_string: 'b' }, { result: undefined })),
    ];
    assert.deepEqual(
      steps(items, true).map((s) => s.status),
      ['done', 'active'],
    );
    assert.deepEqual(
      steps(items, false).map((s) => s.status),
      ['done', 'done'],
    );
  });

  test('a pending permission and a failed result are passthrough, not swallowed', () => {
    const permission = {
      kind: 'permission',
      key: 'p5',
      data: { toolName: 'Bash' },
    } as unknown as TranscriptItem;
    const failed = result('r9', true);
    const out = turnSteps(
      [say('a1', 'Run the migration script now.'), group(tool('t1', 'Bash', { command: 'x' })), permission, failed],
      false,
    );
    assert.deepEqual(
      out.map((e) => e.kind),
      ['step', 'passthrough', 'passthrough'],
    );
    const step = out[0] as TurnStep;
    assert.ok(!step.items.includes(permission));
    assert.ok(!step.items.includes(failed));
  });

  test('a successful result gets no entry at all', () => {
    const out = turnSteps([say('a1', 'Run the migration script now.'), result('r2', false)], false);
    assert.deepEqual(
      out.map((e) => e.kind),
      ['step'],
    );
    assert.equal((out[0] as TurnStep).items.length, 1);
  });

  test('a resolved permission stays inside its step', () => {
    const permission = {
      kind: 'permission',
      key: 'p5',
      data: { toolName: 'Bash' },
      resolution: 'deny',
    } as unknown as TranscriptItem;
    const out = turnSteps([say('a1', 'Run the migration script now.'), permission], false);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'step');
  });

  test('step keys are stable when items are appended', () => {
    const items = [say('a1', 'Read the config loader first.'), group(tool('t1', 'Read', { file_path: '/a' }))];
    const before = steps(items, true).map((s) => s.key);
    const after = steps(
      [...items, group(tool('t2', 'Read', { file_path: '/b' })), say('a3', 'Then update the defaults here.')],
      true,
    ).map((s) => s.key);
    assert.deepEqual(before, ['a1']);
    assert.deepEqual(after, ['a1', 'a3']);
  });
});

describe('turnSteps with MCP calls', () => {
  test('a silent MCP call reads by provider and tool, with its server for the logo', () => {
    const out = steps([group(tool('t1', 'mcp__linear__create_issue', {}))]);
    assert.equal(out.length, 1);
    assert.equal(out[0].label, 'Linear · Create issue');
    assert.equal(out[0].mcpServer, 'linear');
  });

  test('the MCP call input summary follows the title', () => {
    const out = steps([group(tool('t1', 'mcp__vercel__get_runtime_logs', { query: 'timeout' }))]);
    assert.match(out[0].label, /^Vercel · Get runtime logs/);
    assert.equal(out[0].mcpServer, 'vercel');
  });

  test('a narrated step keeps its narration and gets no logo', () => {
    const out = steps([
      say('a1', 'Let me file the bug in the tracker now.'),
      group(tool('t1', 'mcp__linear__create_issue', {})),
    ]);
    assert.equal(out[0].label, 'File the bug in the tracker now');
    assert.equal(out[0].mcpServer, undefined);
  });

  test('a built-in tool step has no mcpServer', () => {
    assert.equal(steps([group(tool('t1', 'Bash', { command: 'ls' }))])[0].mcpServer, undefined);
  });

  test('the tally merges MCP calls per provider', () => {
    assert.deepEqual(
      groupTally([
        tool('t1', 'mcp__linear__create_issue', {}),
        tool('t2', 'Read', { file_path: '/a' }),
        tool('t3', 'mcp__linear__get_issue', {}),
        tool('t4', 'mcp__vercel__list_projects', {}),
        tool('t5', 'Read', { file_path: '/b' }),
      ]),
      [
        { server: 'linear', label: 'Linear', count: 2 },
        { label: 'Read', count: 2 },
        { server: 'vercel', label: 'Vercel', count: 1 },
      ],
    );
  });
});

describe('narrationLabel', () => {
  test('strips markdown, lead-ins, and keeps a file name whole', () => {
    assert.equal(narrationLabel("Now I'll update **`config.ts`** to merge defaults. Then test."), 'Update config.ts to merge defaults');
  });

  test('caps long sentences', () => {
    const label = narrationLabel('Check ' + 'very '.repeat(40) + 'long thing');
    assert.ok(label && label.length <= 80 && label.endsWith('…'));
  });

  test('null for thin text', () => {
    assert.equal(narrationLabel('Let me look.'), null);
  });
});

function create(id: string, n: number, subject: string, activeForm?: string): ToolBlock {
  return tool(id, 'TaskCreate', { subject, description: subject, activeForm }, {
    result: `Task #${n} created successfully: ${subject}`,
  });
}

function update(id: string, taskId: string, status: string): ToolBlock {
  return tool(id, 'TaskUpdate', { taskId, status }, { result: `Updated task #${taskId} status` });
}

describe('turnSteps with a task list', () => {
  const planned = [
    say('a1', 'Look at the upload client and its retry logic.'),
    group(tool('r1', 'Read', { file_path: '/up.ts' })),
    group(create('c1', 1, 'Add retry', 'Adding retry'), create('c2', 2, 'Write tests', 'Writing tests')),
    group(update('u1', '1', 'in_progress')),
    group(tool('e1', 'Edit', { file_path: '/up.ts', old_string: 'a', new_string: 'b' })),
  ];

  test('rows are the tasks, with the work under the one in progress', () => {
    const out = steps(planned, true);
    assert.deepEqual(
      out.map((s) => [s.label, s.status]),
      [
        ['Look at the upload client and its retry logic', 'done'],
        ['Adding retry', 'active'],
        ['Write tests', 'pending'],
      ],
    );
    assert.deepEqual(
      out[1].tools.map((t) => t.id),
      ['e1'],
    );
    assert.equal(out[2].items.length, 0);
  });

  test('task bookkeeping calls get no row of their own', () => {
    const ids = steps(planned, true).flatMap((s) => s.tools.map((t) => t.id));
    assert.ok(!ids.includes('c1') && !ids.includes('u1'));
  });

  test('completing a task moves it to done; a finished turn leaves open tasks pending', () => {
    const out = steps([...planned, group(update('u2', '1', 'completed'))], false);
    assert.deepEqual(
      out.slice(1).map((s) => s.status),
      ['done', 'pending'],
    );
  });

  test('open tasks carry into the next turn', () => {
    const turnA = { kind: 'agent-turn', key: 'tA', items: planned } as TranscriptItem;
    const turnB = {
      kind: 'agent-turn',
      key: 'tB',
      items: [group(update('u3', '1', 'completed'), update('u4', '2', 'in_progress'))],
    } as TranscriptItem;
    const carries = taskCarries([turnA, turnB]);
    assert.equal(carries.has('tA'), false);
    const carry = carries.get('tB')!;
    assert.deepEqual(
      carry.map((t) => [t.subject, t.status]),
      [
        ['Add retry', 'in_progress'],
        ['Write tests', 'pending'],
      ],
    );
    // An unchanged carry is handed back as the same array.
    assert.equal(taskCarries([turnA, turnB], carries).get('tB'), carry);
    const out = steps((turnB as { items: TranscriptItem[] }).items, true).length;
    assert.equal(out, 0, 'without its carry, updates to unknown tasks make no rows');
    const rows = turnSteps((turnB as { items: TranscriptItem[] }).items, true, carry) as TurnStep[];
    assert.deepEqual(
      rows.map((s) => [s.label, s.status]),
      [
        ['Add retry', 'done'],
        ['Writing tests', 'active'],
      ],
    );
  });
});

describe('foldAgentTurns for the checklist', () => {
  const prompt = { kind: 'user', key: 'u1', text: 'go', source: 'web' } as unknown as TranscriptItem;

  test('a lone tool group still gets a turn card', () => {
    const out = foldAgentTurns([prompt, group(tool('t1', 'Read', { file_path: '/a' }))]);
    assert.deepEqual(
      out.map((i) => i.kind),
      ['user', 'agent-turn'],
    );
  });

  test('text still streaming renders after the card, where the answer will be', () => {
    const streaming = { kind: 'streaming', key: 'streaming', text: 'The answer is' } as TranscriptItem;
    const out = foldAgentTurns([prompt, group(tool('t1', 'Read', { file_path: '/a' })), streaming]);
    assert.deepEqual(
      out.map((i) => i.kind),
      ['user', 'agent-turn', 'streaming'],
    );
  });
});
