import type { PermissionRequestData, SessionMeta, TranscriptEvent } from '@lines/shared';
import { CLAUDE_AUTH, OPENAI_AUTH, SESSION_IDLE } from '../fixtures';
import avatar from './page-lines-test/images/ProjectTabs-Frame-1791895214551220-2.jpg';

// The captured "Lines" page: the dev build's view of the lines project, where
// every session runs in the installed app (read-only here), with a workflow
// run open whose planning step has a plan waiting for approval.
//
// Layered over the seeded store for this scenario only (see kubi.config), so
// the stories and other scenarios keep the shared fixtures.

const CWD = '/Users/dev/projects/lines';
const NOW = Date.UTC(2026, 9, 12, 12, 0);
const day = (month: number, date: number) => Date.UTC(2026, month - 1, date, 12, 0);

const base: SessionMeta = {
  id: 'page-lines-test-base',
  name: '',
  cwd: CWD,
  model: 'claude-opus-5-5',
  permissionMode: 'default',
  status: 'done',
  createdAt: NOW,
  readOnly: true,
};

const WORKTREE = `${CWD}-wt/session-resume`;

/** The sidebar's rows, in the order the page listed them (most recent activity first). */
const ROWS: SessionMeta[] = [
  {
    ...base,
    id: 'page-lines-test-plan-mode',
    name: 'Plan Mode Switch Causes Stuck Loading',
    createdAt: day(10, 12),
    totalCostUsd: 3.95,
    totalTokens: 5_412_300,
    totalDurationMs: 747_000,
    workflow: {
      workflowId: 'wf_page_lines_test_bugfix',
      stepIndex: 2,
      stepStatuses: ['done', 'done', 'done'],
      started: true,
      task: 'Switching to plan mode leaves the session stuck on loading.',
    },
  },
  {
    ...base,
    id: 'page-lines-test-composer',
    name: 'Improve Composer Layout and Controls',
    model: 'gpt-6-sol',
    createdAt: day(10, 7),
    totalCostUsd: 21.92,
    // Ran on Codex, which reports no cost: the figure is an estimate.
    costByModel: { 'gpt-6-sol': { costUsd: 21.92, tokens: 28_640_000, turns: 41 } },
    totalTokens: 28_640_000,
    totalDurationMs: 4_215_000,
  },
  {
    ...base,
    id: 'page-lines-test-lensapp',
    name: 'LensApp organic user acquisition strategy',
    createdAt: day(9, 29),
    totalCostUsd: 39.07,
    totalTokens: 41_870_500,
    totalDurationMs: 2_844_000,
  },
  {
    ...base,
    id: 'page-lines-test-voice',
    name: 'Enable continuous voice conversation mode',
    status: 'idle',
    interruptedAt: day(10, 6),
  },
  {
    ...base,
    id: 'page-lines-test-tunnel',
    name: 'Add Cloudflare Tunnel Play Button',
    status: 'idle',
    interruptedAt: day(10, 5),
  },
  {
    ...base,
    id: 'page-lines-test-questions',
    name: 'Comprehensive planning questions for large features',
    status: 'idle',
    interruptedAt: day(10, 4),
  },
  {
    ...base,
    id: 'page-lines-test-resume',
    name: 'Save and resume session transcripts',
    cwd: WORKTREE,
    status: 'idle',
    interruptedAt: day(10, 3),
  },
  {
    ...base,
    id: 'page-lines-test-cursor',
    name: 'Cursor headless mode workflow agent feasibility',
    createdAt: day(8, 13),
    totalCostUsd: 3.47,
    totalTokens: 3_905_200,
    totalDurationMs: 276_000,
  },
  {
    ...base,
    id: 'page-lines-test-full-stack',
    name: 'Full-Stack App Generation Service',
    status: 'idle',
    interruptedAt: day(10, 2),
  },
  {
    ...base,
    id: 'page-lines-test-install',
    name: 'Install Lines on deployed apps',
    status: 'idle',
    interruptedAt: day(10, 1),
  },
  {
    ...base,
    id: 'page-lines-test-preview',
    name: 'Preview UI changes during planning phase',
    status: 'idle',
    interruptedAt: day(9, 30),
  },
  {
    ...base,
    id: 'page-lines-test-new',
    name: 'New session',
    nameAuto: true,
    status: 'idle',
    createdAt: day(9, 29),
  },
].map((s, i) => ({ ...s, updatedAt: NOW - i * 3_600_000 }));

const step = (name: string, autoAdvance: boolean, permissionMode: SessionMeta['permissionMode']) => ({
  name,
  promptTemplate: `${name}: {{task}}`,
  model: 'claude-opus-5-5',
  permissionMode,
  autoAdvance,
  freshStart: false,
});

/**
 * The open session. SessionView's definition hands it `SESSION_IDLE.id`, so the
 * page's session takes that id here. Its cwd is a folder inside the project
 * rather than the project root, which keeps it off the sidebar list: the page
 * listed this session (as interrupted) separately from the open view.
 */
const VIEW: SessionMeta = {
  ...base,
  id: SESSION_IDLE.id,
  name: 'Full-Stack App Generation Service',
  cwd: `${CWD}/app-builder`,
  permissionMode: 'plan',
  // Settled, as the page showed it: the planning turn sits folded (a live one
  // stays open) above the plan card that still waits for an answer.
  status: 'idle',
  workflow: {
    workflowId: 'wf_page_lines_test_fullstack',
    stepIndex: 1,
    stepStatuses: ['done', 'running', 'pending', 'pending', 'pending'],
    started: true,
    task: 'A service that turns an app description into provisioned, deployed infrastructure.',
    stepCostsUsd: [0.43, 4.28],
    stepTokens: [512_400, 5_830_100],
    stepDurationsMs: [59_000, 63_000],
    def: {
      id: 'wf_page_lines_test_fullstack',
      name: 'Full-stack app',
      steps: [
        step('Context Agent', true, 'default'),
        step('Planning Agent', false, 'plan'),
        step('Implementation Agent', false, 'acceptEdits'),
        step('Implementation Agent', true, 'acceptEdits'),
        step('Implementation Agent', false, 'acceptEdits'),
      ],
    },
  },
};

export const SESSIONS: SessionMeta[] = [...ROWS, VIEW];

// ---------------------------------------------------------------------------
// The open session's transcript: an answered question, the folded planning
// turn that followed it, and the plan it ended on.
// ---------------------------------------------------------------------------

let seq = 0;
const ev = (kind: TranscriptEvent['kind'], data: unknown): TranscriptEvent => ({
  seq: ++seq,
  ts: NOW - 600_000 + seq * 2_000,
  kind,
  data,
});

const DEPLOY_OPTIONS = [
  {
    label: 'Direct upload; GitHub is history (recommended v1)',
    description:
      'Keep deploy_app as a direct Workers/Pages API upload. Git is versioning only. Fully automatable end-to-end — no manual step in the middle of the workflow.',
  },
  {
    label: 'Push-to-deploy via Cloudflare Git integration',
    description:
      'Connect the repo, Cloudflare builds and deploys on push. Nicer long-term story, but connecting a repo needs the Cloudflare↔GitHub app installation, which is an interactive dashboard OAuth flow — it cannot be fully provisioned by API, so the workflow would park on a manual step.',
  },
  {
    label: 'Direct now, push-to-deploy later',
    description:
      'Ship direct upload, but have the scaffold write a wrangler.toml and a GitHub Actions workflow so the repo is already deploy-ready if you flip later.',
  },
];

const PLAN_FILE = '/Users/dev/.claude/plans/app-builder.md';

/** One edit to the plan file: `removed` lines out, `added` lines in, around one kept line. */
const planEdit = (n: number, removed: number, added: number) => {
  const kept = `## Section ${n + 1}`;
  const lines = (tag: string, count: number) =>
    Array.from({ length: count }, (_, k) => `- §${n + 1} ${tag} point ${k + 1}`);
  return {
    type: 'tool_use',
    id: `toolu_plt_edit_${n}`,
    name: 'Edit',
    input: {
      file_path: PLAN_FILE,
      old_string: [kept, ...lines('draft', removed)].join('\n'),
      new_string: [kept, ...lines('revised', added)].join('\n'),
    },
  };
};

// 21 edits, +74 −28 between them.
const EDITS = Array.from({ length: 21 }, (_, n) => planEdit(n, n < 7 ? 4 : 0, n < 11 ? 4 : 3));

// First-seen order is what the folded header lists: Edit, Bash, Read.
const TOOLS = [
  ...EDITS.slice(0, 10),
  { type: 'tool_use', id: 'toolu_plt_bash_1', name: 'Bash', input: { command: 'rg -n "gh auth" server/src', description: 'Find local git credential use' } },
  { type: 'tool_use', id: 'toolu_plt_read_1', name: 'Read', input: { file_path: 'server/src/bridge.ts' } },
  ...EDITS.slice(10),
  { type: 'tool_use', id: 'toolu_plt_read_2', name: 'Read', input: { file_path: PLAN_FILE } },
  { type: 'tool_use', id: 'toolu_plt_bash_2', name: 'Bash', input: { command: 'git -C server log --oneline -5', description: 'Recent server commits' } },
  { type: 'tool_use', id: 'toolu_plt_bash_3', name: 'Bash', input: { command: `wc -l ${PLAN_FILE}`, description: 'Plan length' } },
];

const PLAN = `# App Builder — provision real cloud infra from a Lines session

## Context

Today Lines writes code but stops at the repo boundary. A user who says "I want a parts shop where registered users list parts for sale" gets a plan and files, then has to go create a database, an auth tenant, and a host by hand.

This feature closes that gap: a guided workflow turns a natural-language app description into a structured blueprint (DB tables, auth model, API routes, hosting shape), computes a cost estimate from it, then actually provisions GitHub + Neon + Cloudflare + Clerk resources, scaffolds the code against them, commits it, and deploys.

Scope decisions already made (do not re-open):

- **One master account per provider**, already set up, operator-owned. No per-user provider accounts, no reselling, no multi-tenant credential vault.
- **No payments.** The estimate is display-only. No Stripe, no ledger, no charging. (Repo has zero payment code; keep it that way in v1.)
- **v1 providers:** Neon Postgres, Cloudflare Workers/Pages, Clerk, **GitHub**. **No domain registrar** — provider default subdomains only.
- **Server-authoritative Prisma models**, deliberately breaking the repo's \`Json\` blob + last-write-wins + best-effort-sync house pattern.
- **GitHub is the version store for the built app**: one repo per app in a **dedicated org**, holding the source code and \`lines.app.json\` (the blueprint) and \`lines.resources.json\` (redacted handles). Git history is the design history.
- **Lines will be hosted**, so anything credential-shaped must work on a server with no human-configured \`gh auth\` or SSH key. This is what forces the GitHub App path (see §6).
- **Deploy stays a direct Cloudflare upload** in v1; the scaffold still writes \`wrangler.toml\` and an inert \`.github/workflows/deploy.yml\` so push-to-deploy is a later flip, not a rewrite.

The guided experience is built entirely on the existing workflow engine. No new orchestration engine, no job queue.
`;

const PENDING_PLAN: PermissionRequestData = {
  requestId: 'perm_plt_plan',
  toolName: 'ExitPlanMode',
  input: { plan: PLAN },
};

export const VIEW_EVENTS: TranscriptEvent[] = [
  ev('sdk', {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_plt_question',
          name: 'AskUserQuestion',
          input: { questions: [{ question: '', options: DEPLOY_OPTIONS, multiSelect: false }] },
        },
      ],
    },
  }),
  ev('sdk', {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_plt_question',
          content: `User has answered your questions: ""="${DEPLOY_OPTIONS[0].label}". You can now continue with the user's answers in mind.`,
        },
      ],
    },
  }),
  ev('sdk', {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'text',
          text: 'Answer changes one thing structurally: **hosted bridge kills "use the machine\'s local git creds."** That forces the GitHub App path. Rewriting the affected sections.',
        },
        ...TOOLS,
      ],
    },
  }),
  ev('sdk', {
    type: 'user',
    message: {
      content: TOOLS.map((t) => ({
        type: 'tool_result',
        tool_use_id: t.id,
        content: t.name === 'Edit' ? `The file ${PLAN_FILE} has been updated.` : 'ok',
      })),
    },
  }),
  ev('sdk', {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'text',
          text: 'Plan updated.\n\nGitHub delta: **Hosted bridge → GitHub App installation tokens**, minted per repo; no personal access token, no `gh auth` on the host.',
        },
        { type: 'tool_use', id: 'toolu_plt_exit_plan', name: 'ExitPlanMode', input: { plan: PLAN } },
      ],
    },
  }),
  ev('permission', PENDING_PLAN),
];

// ---------------------------------------------------------------------------
// Header and window
// ---------------------------------------------------------------------------

export const account = { imageUrl: avatar };

/** The page's window: 1512 wide, 691 under the 56px header. */
export const layout = {
  '--kubi-window-width': '1512px',
  '--kubi-shell-height': '691px',
  '--kubi-main-width': '1232px',
};

/** The sidebar listed by last activity, not by urgency. */
export const sessionSort = 'activity';

const HOUR = 3_600_000;

/** Store fields this page shows differently from the shared fixtures. */
export const store = {
  sessions: Object.fromEntries(SESSIONS.map((s) => [s.id, s])),
  transcripts: { [VIEW.id]: VIEW_EVENTS },
  transcriptLoaded: Object.fromEntries(SESSIONS.map((s) => [s.id, true])),
  sessionMachine: {},
  presence: {},
  queuedPrompts: [],
  projects: [
    {
      path: CWD,
      worktrees: [{ path: WORKTREE, branch: 'session-resume', baseRef: 'main', createdByLines: true as const }],
    },
  ],
  projectKeys: {},
  activeProject: CWD,
  selectedSessionId: VIEW.id,
  auth: CLAUDE_AUTH,
  openaiAuth: OPENAI_AUTH,
  usage: {
    windows: [
      { id: 'five_hour', utilization: 16, resetsAt: new Date(NOW + 3 * HOUR).toISOString() },
      { id: 'seven_day', utilization: 22, resetsAt: new Date(NOW + 4 * 24 * HOUR).toISOString() },
    ],
    fetchedAt: NOW,
    plan: 'Max',
  },
  openaiUsage: {
    windows: [
      { id: 'primary', label: '5-hour limit', utilization: 0, resetsAt: new Date(NOW + 5 * HOUR).toISOString() },
      { id: 'secondary', label: 'Weekly', utilization: 3, resetsAt: new Date(NOW + 6 * 24 * HOUR).toISOString() },
    ],
    fetchedAt: NOW,
    plan: 'Pro',
  },
};
