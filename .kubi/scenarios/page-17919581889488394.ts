import type { PermissionRequestData, SessionMeta, TranscriptEvent } from '@lines/shared';
import { CLAUDE_AUTH, OPENAI_AUTH, OWNER, SESSION_IDLE } from '../fixtures';
import avatar from './page-17919581889488394/images/ProjectTabs-Frame-17919581889388156-2.jpg';
import promptAvatar from './page-17919581889488394/images/SessionView-Frame-17919581889288015-1.jpg';

// The captured "Lines" page with a fresh plan-mode session open: the user said
// hello, Claude answered and is waiting on a question about what to plan. The
// sidebar is the lines project's list, with its 350 archived sessions below.
//
// Layered over the seeded store for this scenario only (see kubi.config), so
// the stories and other scenarios keep the shared fixtures.

const CWD = '/Users/dev/projects/lines';
const NOW = Date.UTC(2026, 9, 14, 12, 0);
const day = (month: number, date: number) => Date.UTC(2026, month - 1, date, 12, 0);

const base: SessionMeta = {
  id: 'page-17919581889488394-base',
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
    id: 'page-17919581889488394-composer',
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
    id: 'page-17919581889488394-lensapp',
    name: 'LensApp organic user acquisition strategy',
    createdAt: day(9, 29),
    totalCostUsd: 39.07,
    totalTokens: 41_870_500,
    totalDurationMs: 2_844_000,
  },
  {
    ...base,
    id: 'page-17919581889488394-voice',
    name: 'Enable continuous voice conversation mode',
    status: 'idle',
    interruptedAt: day(10, 6),
  },
  {
    ...base,
    id: 'page-17919581889488394-tunnel',
    name: 'Add Cloudflare Tunnel Play Button',
    status: 'idle',
    interruptedAt: day(10, 5),
  },
  {
    ...base,
    id: 'page-17919581889488394-questions',
    name: 'Comprehensive planning questions for large features',
    status: 'idle',
    interruptedAt: day(10, 4),
  },
  {
    ...base,
    id: 'page-17919581889488394-resume',
    name: 'Save and resume session transcripts',
    cwd: WORKTREE,
    status: 'idle',
    interruptedAt: day(10, 3),
  },
  {
    ...base,
    id: 'page-17919581889488394-cursor',
    name: 'Cursor headless mode workflow agent feasibility',
    createdAt: day(8, 13),
    totalCostUsd: 3.47,
    totalTokens: 3_905_200,
    totalDurationMs: 276_000,
  },
  {
    ...base,
    id: 'page-17919581889488394-full-stack',
    name: 'Full-Stack App Generation Service',
    status: 'idle',
    interruptedAt: day(10, 2),
  },
  {
    ...base,
    id: 'page-17919581889488394-install',
    name: 'Install Lines on deployed apps',
    status: 'idle',
    interruptedAt: day(10, 1),
  },
  {
    ...base,
    id: 'page-17919581889488394-preview',
    name: 'Preview UI changes during planning phase',
    status: 'idle',
    interruptedAt: day(9, 30),
  },
  {
    ...base,
    id: 'page-17919581889488394-new',
    name: 'New session',
    nameAuto: true,
    status: 'idle',
    createdAt: day(9, 29),
  },
].map((s, i) => ({ ...s, updatedAt: NOW - (i + 1) * 3_600_000 }));

/**
 * The "Archived (350)" group. Its rows sat below the fold, so the page did not
 * show their names; these stand in for them.
 */
const ARCHIVED: SessionMeta[] = Array.from({ length: 350 }, (_, i) => ({
  ...base,
  id: `page-17919581889488394-archived-${i + 1}`,
  name: `Archived session ${i + 1}`,
  archived: true,
  createdAt: day(8, 1),
  updatedAt: day(8, 1) - i * 60_000,
}));

/**
 * The open session. SessionView's definition hands it `SESSION_IDLE.id`, so the
 * page's session takes that id here. Its cwd is a folder inside the project
 * rather than the project root, which keeps it off the sidebar list: the page
 * did not list it there.
 */
const VIEW: SessionMeta = {
  ...base,
  id: SESSION_IDLE.id,
  name: 'Greeting',
  cwd: `${CWD}/web`,
  permissionMode: 'plan',
  readOnly: false,
  // Stopped on Claude's question: the tool call is still running.
  status: 'waiting-permission',
  pendingPermissionTool: 'AskUserQuestion',
  createdAt: NOW - 120_000,
  updatedAt: NOW,
};

export const SESSIONS: SessionMeta[] = [...ROWS, ...ARCHIVED, VIEW];

// ---------------------------------------------------------------------------
// The open session's transcript: the greeting, Claude's reply and the question
// it is waiting on.
// ---------------------------------------------------------------------------

let seq = 0;
const ev = (kind: TranscriptEvent['kind'], data: unknown): TranscriptEvent => ({
  seq: ++seq,
  ts: NOW - 120_000 + seq * 2_000,
  kind,
  data,
});

const QUESTION = {
  questions: [
    {
      header: 'Task',
      question: 'What should we plan?',
      multiSelect: false,
      options: [
        {
          label: 'ActivityRow WIP',
          description: 'Continue uncommitted changes in web/src/components/ActivityRow.tsx and web/src/index.css',
        },
        {
          label: 'Multi-user plan',
          description: 'Resume Clerk/Supabase multi-user work (Phase 1 store DI done)',
        },
        {
          label: 'Activity indicator',
          description: 'Pending activity-indicator plan in ~/.claude/plans',
        },
        { label: 'Something else', description: 'Describe new task' },
      ],
    },
  ],
};

const PENDING_QUESTION: PermissionRequestData = {
  requestId: 'perm_p179_question',
  toolName: 'AskUserQuestion',
  input: QUESTION,
};

export const VIEW_EVENTS: TranscriptEvent[] = [
  // The owner's own prompt, carrying the photo the page showed beside it.
  ev('user', { text: 'hello', actor: { userId: OWNER.userId, name: OWNER.name, imageUrl: promptAvatar } }),
  ev('sdk', { type: 'system', subtype: 'init', model: 'claude-opus-5-5' }),
  ev('sdk', {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'text',
          text: "Hi. Plan mode is on. Linear MCP isn't authorized, so its tools are unavailable. To use them, authorize Linear via `/mcp` in an interactive session or in claude.ai connector settings.",
        },
        { type: 'tool_use', id: 'toolu_p179_question', name: 'AskUserQuestion', input: QUESTION },
      ],
    },
  }),
  ev('permission', PENDING_QUESTION),
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

/** The archived group was open, its first page below the fold. */
export const showArchived = true;

const HOUR = 3_600_000;

/** Store fields this page shows differently from the shared fixtures. */
export const store = {
  sessions: Object.fromEntries(SESSIONS.map((s) => [s.id, s])),
  transcripts: { [VIEW.id]: VIEW_EVENTS },
  transcriptLoaded: Object.fromEntries(SESSIONS.map((s) => [s.id, true])),
  sessionMachine: {},
  presence: {},
  queuedPrompts: [],
  turnSpend: {},
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
  // Both plans read 0% on the page.
  usage: {
    windows: [
      { id: 'five_hour', utilization: 0, resetsAt: new Date(NOW + 5 * HOUR).toISOString() },
      { id: 'seven_day', utilization: 0, resetsAt: new Date(NOW + 6 * 24 * HOUR).toISOString() },
    ],
    fetchedAt: NOW,
    plan: 'Max',
  },
  openaiUsage: {
    windows: [
      { id: 'primary', label: '5-hour limit', utilization: 0, resetsAt: new Date(NOW + 5 * HOUR).toISOString() },
      { id: 'secondary', label: 'Weekly', utilization: 0, resetsAt: new Date(NOW + 6 * 24 * HOUR).toISOString() },
    ],
    fetchedAt: NOW,
    plan: 'Pro',
  },
};
