import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { GuardAllowEntry, PermissionMode, SessionMeta } from '@lines/shared';
import {
  assessToolCall,
  classifyPlanBash,
  GuardAllowlist,
  isPlanPath,
  isReadOnlyBash,
  isSafePlanModeRead,
  isSafePlanWrite,
  isSafeReadOnly,
  planModeVerdict,
} from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import type { WorkerClient, WorkerRpc } from './workerClient.ts';

const cwd = '/Users/x/Projects/lines';
/** The guard takes every root a session may work in; this suite is single-root. */
const roots = [cwd];
const home = os.homedir();
const homePlan = path.join(home, '.claude', 'plans', 'my-plan.md');
const projectPlan = path.join(cwd, '.claude', 'plans', 'my-plan.md');
// Kept unnormalised on purpose: isPlanPath must resolve, not substring-match.
const traversal = `${home}/.claude/plans/../../.ssh/id_rsa`;
const traversalOutOfTree = `/tmp/x/.claude/plans/../../../../etc/hosts`;

test('reading the home plan file is observation-only', () => {
  assert.equal(isSafeReadOnly('Read', { file_path: homePlan }, roots, []), true);
  assert.equal(assessToolCall('Read', { file_path: homePlan }, roots, []).dangerous, false);
});

test('reading a project-local plan file is observation-only', () => {
  assert.equal(isSafeReadOnly('Read', { file_path: projectPlan }, roots, []), true);
});

test('Write/Edit/MultiEdit of a plan file is a safe plan write', () => {
  assert.equal(isSafePlanWrite('Write', { file_path: homePlan }, roots), true);
  assert.equal(isSafePlanWrite('Edit', { file_path: homePlan }, roots), true);
  assert.equal(isSafePlanWrite('MultiEdit', { file_path: projectPlan }, roots), true);
  assert.equal(isSafePlanWrite('NotebookEdit', { notebook_path: homePlan }, roots), true);
});

test('non-file tools are never a safe plan write', () => {
  assert.equal(isSafePlanWrite('Bash', { command: `cat ${homePlan}` }, roots), false);
  assert.equal(isSafePlanWrite('Read', { file_path: homePlan }, roots), false);
});

test('writing outside the plan directory is not a safe plan write', () => {
  assert.equal(isSafePlanWrite('Write', { file_path: path.join(home, 'notes.md') }, roots), false);
  assert.equal(isSafePlanWrite('Write', {}, roots), false);
});

test('traversal out of the plan directory is not treated as a plan path', () => {
  assert.equal(isSafePlanWrite('Write', { file_path: traversal }, roots), false);
  assert.equal(isSafeReadOnly('Read', { file_path: traversal }, roots, []), false);
  const verdict = assessToolCall('Read', { file_path: traversal }, roots, []);
  assert.equal(verdict.dangerous, true);
  assert.equal(verdict.reason, 'Touches credential/secret files outside the project');

  assert.equal(isSafePlanWrite('Write', { file_path: traversalOutOfTree }, roots), false);
  assert.equal(
    assessToolCall('Write', { file_path: traversalOutOfTree }, roots, []).reason,
    'File access outside the working directory',
  );
});

test('credential and out-of-cwd file access still escalates', () => {
  assert.equal(
    assessToolCall('Read', { file_path: path.join(home, '.ssh', 'config') }, roots, []).reason,
    'Touches credential/secret files outside the project',
  );
  assert.equal(
    assessToolCall('Read', { file_path: '/tmp/other/.env' }, roots, []).reason,
    'Touches credential/secret files outside the project',
  );
  assert.equal(
    assessToolCall('Read', { file_path: '/tmp/other/app.ts' }, roots, []).reason,
    'File access outside the working directory',
  );
});

test('in-cwd writes keep their existing verdict', () => {
  assert.equal(
    assessToolCall('Write', { file_path: path.join(cwd, 'server/src/a.ts') }, roots, []).dangerous,
    false,
  );
});

// isPlanPath is exported because the /file route and the step-output plan read
// both gate on it, so its containment rules are asserted directly here.
test('isPlanPath accepts the home and project plan directories', () => {
  assert.equal(isPlanPath(homePlan, roots), true);
  assert.equal(isPlanPath(projectPlan, roots), true);
  // The home plans dir is cwd-independent — no roots needed.
  assert.equal(isPlanPath(homePlan, []), true);
});

test('isPlanPath rejects traversal out of a plan directory', () => {
  assert.equal(isPlanPath(traversal, roots), false);
  assert.equal(isPlanPath(traversalOutOfTree, roots), false);
  assert.equal(isPlanPath(`${home}/.claude/plans/../../../.ssh/id_rsa`, roots), false);
});

test('isPlanPath rejects paths outside every plan directory', () => {
  assert.equal(isPlanPath('/etc/passwd', roots), false);
  assert.equal(isPlanPath(path.join(cwd, 'server/src/index.ts'), roots), false);
  assert.equal(isPlanPath(projectPlan, []), false);
});

test('ExitPlanMode and AskUserQuestion always reach the user', () => {
  assert.equal(isSafeReadOnly('ExitPlanMode', {}, roots, []), false);
  assert.equal(isSafeReadOnly('AskUserQuestion', {}, roots, []), false);
  assert.equal(isSafePlanWrite('ExitPlanMode', { file_path: homePlan }, roots), false);
});

/** A manager over a throwaway store holding one session in `permissionMode`. */
function hookHarness(permissionMode: PermissionMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-always-ask-'));
  const store = createStore(root);
  fs.writeFileSync(
    path.join(root, 'sessions.json'),
    JSON.stringify([
      {
        id: 's1',
        name: 's1',
        cwd,
        model: 'claude-opus-5-5',
        permissionMode,
        status: 'running',
        createdAt: 1,
      } as SessionMeta,
    ]),
  );
  const sessions = new SessionManager(store, new GuardAllowlist(store), () => {});
  const answered: unknown[] = [];
  sessions.attachWorker({
    push: () => {},
    close: () => {},
    rpcResult: (_id: string, result: unknown) => answered.push(result),
  } as unknown as WorkerClient);
  return { sessions, answered };
}

const preToolUse = (toolName: string): WorkerRpc => ({
  id: 'r1',
  sessionId: 's1',
  kind: 'preToolUse',
  resend: false,
  payload: { tool_name: toolName, tool_input: {} },
});

test('bypass mode allows a tool the guard would otherwise prompt for', async () => {
  const h = hookHarness('bypassPermissions');
  await h.sessions.handleWorkerRpc(preToolUse('Bash'));
  const answer = h.answered[0] as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(answer.hookSpecificOutput?.permissionDecision, 'allow');
});

test('bypass mode still asks for a Lines workflow write', async () => {
  const h = hookHarness('bypassPermissions');
  await h.sessions.handleWorkerRpc(preToolUse('mcp__lines__save_step'));
  const answer = h.answered[0] as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(answer.hookSpecificOutput?.permissionDecision, 'ask');
});

test('the hook forces a prompt for always-ask tools in every mode', async () => {
  const modes: PermissionMode[] = ['default', 'plan', 'auto', 'bypassPermissions'];
  for (const mode of modes) {
    for (const tool of ['ExitPlanMode', 'AskUserQuestion']) {
      const h = hookHarness(mode);
      await h.sessions.handleWorkerRpc(preToolUse(tool));
      const answer = h.answered[0] as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      // A bare `continue: true` would let bypassPermissions / settings.json
      // permissions.allow resolve this before canUseTool ever runs.
      assert.equal(answer.hookSpecificOutput?.permissionDecision, 'ask', `${tool} in ${mode}`);
      assert.equal(
        answer.hookSpecificOutput?.permissionDecisionReason,
        'This decision is always the user’s.',
        `${tool} in ${mode}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Plan-mode read allowlist (isReadOnlyBash / isSafePlanModeRead)
// ---------------------------------------------------------------------------

// Real planning-step commands from transcripts that raised a card.
const READ_ONLY_SAMPLES = [
  'cd /x && ls',
  'grep -rn A web/src --include="*.tsx" | grep -v B',
  'git log --oneline -3; echo ---; grep -n x f',
  'for f in a b; do echo "== $f"; grep -n x $f; done',
  "find ~/Downloads -maxdepth 2 -iname '*.png' 2>/dev/null | head",
  'ls /tmp | grep -i lines',
  'npx tsc --noEmit -p apps/generator 2>&1 | head -20',
  "sed -n '1,120p' f",
  'grep -E "a|b" f > /dev/null',
  'git branch',
  'git branch -a',
  'git tag --list v1*',
  'git remote -v',
  'git config --get user.name',
  // Rejected in plan mode before substitutions, stream sed, uppercase
  // assignments, xargs, find -exec and curl were classified.
  'f=$(grep -rl x .)',
  'ls `pwd`',
  'diff <(ls a) <(ls b)',
  'echo "n: $(grep -c x f | wc -l)"',
  "grep -nE '^export ' f | sed -E 's/\\{.*$//' | cut -c1-160",
  "cat -n f | sed 's/^/L+59 /' | head",
  "sed -n '/a/,/b/p;3q' f",
  'F=$(grep -rl x src | head -1); echo "FILE: $F"; grep -n y "$F"',
  'P=node_modules/x; test -d a/node_modules/x && P=a/node_modules/x; ls $P',
  "find . -type f -name '*.ts' -exec cat {} + | wc -l",
  'grep -rl x src | xargs grep -ln y',
  'curl -sS -m 20 -D - -o /dev/null "https://esm.sh/x?target=es2022" | head -30',
  'echo $((1 + 2))',
  'grep x <<< "$v"',
  '(cd a && ls)',
  'while read f; do wc -l "$f"; done < list',
  'git stash list',
  'npm ls react',
  // The second mining pass, over every plan-mode call on record.
  'grep -rniE "vercel|deploy|launchctl" docs',
  'grep -n "Kill the session" f',
  "cat <<'EOF'\nany $(text) here\nEOF",
  "awk 'NR>=1400 && NR<=1640' f",
  "awk -F: '$1>1283' f",
  'gh run list --workflow=deploy.yml --limit 12 --json headSha',
  'gh pr view 12 --json title',
  "gh api -X GET search/code -f q='x repo:a/b' --jq '.items[].path'",
  'git config user.name',
  'git tag --sort=-creatordate | head',
  'git tag --contains fa1b46b',
  'git check-ignore -v a/b.ts',
  'dd if=f bs=1 skip=10 count=20 2>/dev/null',
  'claude --help 2>&1 | head',
  'cloudflared tunnel run --help',
  'time grep -c x f',
  'timeout 5 ls',
  'LC_ALL=C /usr/bin/grep -a -o x f | LC_ALL=C sort -u',
  'command -v tilt >/dev/null && echo yes',
  'n=0; while [ $n -lt 40 ]; do n=$((n+1)); sleep 5; done; echo waited',
];

const WRITE_SAMPLES = [
  "python3 - <<'EOF'\nprint(1)\nEOF",
  "cat > /tmp/x <<'EOF'\nhi\nEOF",
  'echo x >> f',
  'echo x > f',
  'sed -i s/a/b/ f',
  "sed -n 'w out' f",
  'find . -delete',
  'find . -exec rm {} \;',
  'npm install',
  'rm -f x',
  'git commit-tree HEAD^{tree}',
  'git worktree add ../x',
  'git push origin main',
  'git log --output=x',
  'git branch newname',
  'git tag v2',
  "ssh host 'ls'",
  'cat ~/.ssh/config',
  `cat ${home}/.ssh/id_rsa`,
  "awk 'BEGIN{system(\"rm x\")}'",
  "awk '{print > \"out\"}' f",
  "node -e 'console.log(1)'",
  "python3 -c 'print(1)'",
  'sort -o out f',
  'tree -o out',
  'env X=1 rm x',
  'ls & rm x',
  '(cd x && rm y)',
  'PATH=/evil ls',
  'rg --pre ./script x',
  'uniq in out',
  'tsc',
  "sed 's/a/b/w out' f",
  "sed '1e ls' f",
  "sed '1r /etc/passwd' f",
  'echo $(rm x)',
  'diff <(rm x) f',
  'echo "$(touch x)"',
  'find . -exec rm {} +',
  'ls | xargs rm',
  'curl -d x https://x',
  'curl -o out https://x',
  'curl -sSo out https://x',
  'curl -X POST https://x',
  'curl -H @headers https://x',
  "curl -w '%output{f}' https://x",
  'GIT_PAGER=x git log',
  'HOME=/tmp git log',
  'git -c core.pager=x log',
  'echo $(( $(rm x) ))',
  'ls >&out',
  "bash <<'EOF'\nls\nEOF",
  'cat <<EOF\n$(rm x)\nEOF',
  "awk '{print > \"out\"}' f",
  "awk 'NR>1 {print | \"sh\"}' f",
  'gh api -X POST repos/a/b/issues',
  'gh api repos/a/b/issues -f title=x',
  'gh pr merge 12',
  'dd if=a of=b',
  'TMPDIR=/x ls',
  'git config user.name x',
  'timeout 5 rm x',
  'cat > /tmp/x <<EOF\nhi\nEOF',
];

test('read-only Bash from real planning transcripts is recognised', () => {
  for (const command of READ_ONLY_SAMPLES) {
    assert.equal(isReadOnlyBash(command), true, command);
  }
});

test('writes, execution, substitutions and credential reads are not read-only', () => {
  for (const command of WRITE_SAMPLES) {
    assert.equal(isReadOnlyBash(command), false, command);
  }
});

test('plan-mode Bash separates recognised writes from commands it cannot check', () => {
  for (const command of [
    'rm x',
    'echo x > f',
    'npm install x',
    'git commit -m x',
    'git -C /x push',
    'sed -i s/a/b/ f',
    'ls; rm x',
    'ls | xargs rm',
    'echo $(mv a b)',
    'cat ~/.ssh/config',
  ]) {
    assert.equal(classifyPlanBash(command).kind, 'write', command);
  }
  for (const command of [
    "node -e 'console.log(1)'",
    "python3 - <<'E'\nprint(1)\nE",
    'make test',
    'ls & wc',
    'PATH=/x ls',
    // Scratch files under a temp dir ask rather than being rejected.
    "cat > /tmp/x.mjs <<'EOF'\nhi\nEOF",
    'mkdir -p /tmp/shots',
    'rm -rf /tmp/clerkloc',
  ]) {
    assert.equal(classifyPlanBash(command).kind, 'unknown', command);
  }
  // …but never through a traversal, and never into the project.
  assert.equal(classifyPlanBash('rm -rf /tmp/../Users/x').kind, 'write');
  assert.equal(classifyPlanBash('echo x > /tmp/../etc/x').kind, 'write');
  assert.equal(classifyPlanBash('git push --force').kind, 'write');
  assert.equal(classifyPlanBash('npx -y some-pkg').kind, 'write');
});

test('a heredoc-fed interpreter names a prefix, and an absolute system path its bare name', () => {
  const heredoc = classifyPlanBash("python3 - \"$f\" <<'EOF'\nprint(1)\nEOF");
  assert.equal('prefix' in heredoc && heredoc.prefix, 'python3 -');
  const abs = classifyPlanBash("/usr/bin/python3 -c 'print(1)'");
  assert.equal('prefix' in abs && abs.prefix, 'python3 -c');
  const planRead: GuardAllowEntry[] = [{ tool: 'Bash', prefix: 'python3 -c', scope: 'plan-read' }];
  assert.equal(isReadOnlyBash("/usr/bin/python3 -c 'print(1)'", planRead), true);
});

test('Monitor commands are classified like Bash', () => {
  assert.equal(isSafePlanModeRead('Monitor', { command: 'sleep 240; echo waited' }, roots, []), true);
  assert.equal(planModeVerdict('Monitor', { command: 'rm x' }, []).kind, 'write');
});

test('an unrecognised command names the prefix Allow as read would record', () => {
  assert.deepEqual(classifyPlanBash("cd /x && node -e 'require(1)'"), {
    kind: 'unknown',
    reason: "`node -e` isn't on the plan-mode read-only list",
    prefix: 'node -e',
  });
  const background = classifyPlanBash('ls & wc');
  assert.equal('prefix' in background && background.prefix, false);
});

test('a plan-read entry makes its prefix a read, and nothing more', () => {
  const planRead: GuardAllowEntry[] = [{ tool: 'Bash', prefix: 'node -e', scope: 'plan-read' }];
  assert.equal(isReadOnlyBash("node -e 'console.log(1)'", planRead), true);
  assert.equal(isReadOnlyBash("cd x && node -e '1' | head", planRead), true);
  // An auto-mode entry is a different question.
  assert.equal(isReadOnlyBash("node -e '1'", [{ tool: 'Bash', prefix: 'node -e' }]), false);
  // Writes and BASH_RULES still win.
  assert.equal(classifyPlanBash("node -e '1'; rm x", planRead).kind, 'write');
  assert.equal(classifyPlanBash("node -e '1' && sudo ls", planRead).kind, 'write');
  assert.equal(isSafePlanModeRead('Bash', { command: "node -e '1'" }, roots, planRead), true);
});

test('a plan-read entry never widens the auto-mode guard', () => {
  const planRead: GuardAllowEntry[] = [{ tool: 'Bash', prefix: 'git push', scope: 'plan-read' }];
  assert.equal(assessToolCall('Bash', { command: 'git push --force' }, roots, planRead).dangerous, true);
});

test('plan mode rejects recognised writes by tool, and leaves the rest to the user', () => {
  assert.equal(planModeVerdict('Edit', { file_path: path.join(cwd, 'a.ts') }, []).kind, 'write');
  assert.equal(planModeVerdict('mcp__x__create_thing', {}, []).kind, 'write');
  assert.equal(planModeVerdict('mcp__lines__save_step', {}, []).kind, 'write');
  assert.equal(planModeVerdict('mcp__pencil__batch_get', {}, []).kind, 'unknown');
  assert.equal(planModeVerdict('CronCreate', {}, []).kind, 'unknown');
});

test('an empty command is not read-only', () => {
  assert.equal(isReadOnlyBash('  '), false);
});

test('plan-mode reads never cover the always-ask tools', () => {
  assert.equal(isSafePlanModeRead('ExitPlanMode', {}, roots, []), false);
  assert.equal(isSafePlanModeRead('AskUserQuestion', {}, roots, []), false);
});

test('plan-mode reads cover web reads, subagents and skills', () => {
  for (const tool of ['WebFetch', 'WebSearch', 'Agent', 'Skill', 'TaskCreate', 'SendMessage']) {
    assert.equal(isSafePlanModeRead(tool, {}, roots, []), true, tool);
  }
});

test('plan-mode reads cover MCP read tools only', () => {
  assert.equal(isSafePlanModeRead('mcp__x__list_things', {}, roots, []), true);
  assert.equal(isSafePlanModeRead('mcp__x__create_thing', {}, roots, []), false);
  // "review" contains "view" but is a write.
  assert.equal(isSafePlanModeRead('mcp__x__submit_diff_review', {}, roots, []), false);
});

test('plan-mode reads keep escalating credential reads and project edits', () => {
  assert.equal(isSafePlanModeRead('Read', { file_path: path.join(home, '.ssh', 'id_rsa') }, roots, []), false);
  assert.equal(isSafePlanModeRead('Edit', { file_path: path.join(cwd, 'a.ts') }, roots, []), false);
});

test('plan-mode reads classify Bash with the read-only allowlist', () => {
  assert.equal(isSafePlanModeRead('Bash', { command: 'ls | head' }, roots, []), true);
  assert.equal(isSafePlanModeRead('Bash', { command: 'npm install x' }, roots, []), false);
});
