import type {
  ModelOption,
  PermissionRequestData,
  SessionMeta,
  TranscriptEvent,
} from '@lines/shared';

// Shared fixtures for the session surfaces (composer, transcript, queue rows).
// Paths, names and ids are invented; nothing here points at a real machine.

const T0 = Date.UTC(2026, 9, 12, 9, 30);
const CWD = '/Users/dev/projects/lines';

export const FIXTURE_MODELS: ModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', description: 'For long-running agentic coding and knowledge work', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: 'Balanced speed and capability', contextWindow: 1_000_000 },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', description: 'Fastest and cheapest, for lightweight tasks', contextWindow: 200_000 },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', description: 'OpenAI — for complex coding and agentic work', provider: 'openai' },
];

export const ADA = { userId: 'user_fixture_ada', name: 'Ada Lovelace', imageUrl: null };

const contextSummary = {
  at: T0 + 60_000,
  model: 'claude-opus-5-5',
  totalTokens: 184_300,
  maxTokens: 1_000_000,
  percentage: 18,
  categories: [
    { name: 'System prompt', tokens: 3_100 },
    { name: 'System tools', tokens: 14_800 },
    { name: 'Memory files', tokens: 2_400 },
    { name: 'Messages', tokens: 164_000 },
  ],
  autoCompactThreshold: 900_000,
  isAutoCompactEnabled: true,
};

const base: SessionMeta = {
  id: 'kubi-session-idle',
  name: 'Fix reconnect backoff',
  cwd: CWD,
  model: 'claude-opus-5-5',
  permissionMode: 'default',
  status: 'done',
  createdAt: T0,
  claudeSessionId: 'fixture-claude-conversation',
  totalCostUsd: 0.42,
  lastCostUsd: 0.11,
  contextSummary,
};

export const SESSION_IDLE: SessionMeta = base;

export const SESSION_RUNNING: SessionMeta = {
  ...base,
  id: 'kubi-session-running',
  name: 'Add retry to relay socket',
  status: 'running',
  turnStartedAt: T0 + 120_000,
};

export const SESSION_WAITING: SessionMeta = {
  ...base,
  id: 'kubi-session-waiting',
  name: 'Run the migration',
  status: 'waiting-permission',
  pendingPermissionTool: 'Bash',
};

export const SESSION_FAILED: SessionMeta = {
  ...base,
  id: 'kubi-session-failed',
  name: 'Bump Prisma',
  status: 'error',
  errorMessage: 'API Error: 529 Overloaded',
};

export const SESSION_EMPTY: SessionMeta = {
  ...base,
  id: 'kubi-session-empty',
  name: 'New session',
  status: 'idle',
  claudeSessionId: undefined,
  totalCostUsd: undefined,
  lastCostUsd: undefined,
  contextSummary: undefined,
};

export const SESSION_CODEX: SessionMeta = {
  ...base,
  id: 'kubi-session-codex',
  name: 'Tidy the CLI flags',
  model: 'gpt-6-sol',
  claudeSessionId: undefined,
  codexThreadId: 'fixture-codex-thread',
  contextSummary: undefined,
};

export const SESSION_QUEUED: SessionMeta = {
  ...SESSION_RUNNING,
  id: 'kubi-session-queued',
  name: 'Cover the 1008 close path',
  queued: [
    {
      id: 'q1',
      ts: T0 + 180_000,
      text: 'After this, also cover the 1008 close code in the tests.',
    },
    {
      id: 'q2',
      ts: T0 + 200_000,
      text: 'Then update docs/relay.md with the new backoff table.',
      mentions: [{ kind: 'file', id: 'docs/relay.md', label: 'relay.md' }],
      actor: ADA,
    },
  ],
};

export const SESSION_QUEUE_PAUSED: SessionMeta = {
  ...SESSION_IDLE,
  id: 'kubi-session-queue-paused',
  name: 'Safari reconnect jitter',
  queuePaused: true,
  queued: [
    { id: 'q3', ts: T0 + 240_000, text: 'Can you also check the reconnect jitter on Safari?', actor: ADA },
  ],
};

export const SESSION_STEERING: SessionMeta = {
  ...SESSION_RUNNING,
  id: 'kubi-session-steering',
  name: 'Relay heartbeat interval',
  steering: [
    { id: 's1', ts: T0 + 190_000, text: 'Keep the max delay at 30s, not 60s.' },
  ],
};

export const SESSION_OFFLINE: SessionMeta = {
  ...SESSION_IDLE,
  id: 'kubi-session-offline',
  name: 'Rename retryDelay',
};

export const ALL_SESSIONS = [
  SESSION_IDLE,
  SESSION_RUNNING,
  SESSION_WAITING,
  SESSION_FAILED,
  SESSION_EMPTY,
  SESSION_CODEX,
  SESSION_QUEUED,
  SESSION_QUEUE_PAUSED,
  SESSION_STEERING,
  SESSION_OFFLINE,
];

/** Held in this browser while the link is down — read by OfflineQueuedMessages. */
export const OFFLINE_PROMPTS = [
  {
    id: 'local-1',
    sessionId: SESSION_OFFLINE.id,
    text: 'Rename `retryDelay` to `backoffMs` everywhere.',
    queuedAt: T0 + 300_000,
  },
];

// ---------------------------------------------------------------------------
// Transcript events
// ---------------------------------------------------------------------------

let seq = 0;
const ev = (kind: TranscriptEvent['kind'], data: unknown, at = T0 + seq * 4_000): TranscriptEvent => ({
  seq: ++seq,
  ts: at,
  kind,
  data,
});

const READ_RESULT =
  "export function nextDelay(attempt: number): number {\n  return Math.min(1000 * 2 ** attempt, 60_000);\n}\n";

/** One settled exchange: prompt, a few tool calls, an edit, an answer, a result. */
export const CONVERSATION_EVENTS: TranscriptEvent[] = [
  ev('sdk', { type: 'system', subtype: 'init', model: 'claude-opus-5-5' }),
  ev('user', {
    text: 'The relay reconnect backs off forever after a 1008 close. Can you cap it and add jitter?',
    mentions: [{ kind: 'file', id: 'web/src/ws.ts', label: 'ws.ts' }],
  }),
  ev('sdk', {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: "Let me look at how the delay is computed first." },
        { type: 'tool_use', id: 'toolu_fx_read', name: 'Read', input: { file_path: 'web/src/lib/backoff.ts' } },
        { type: 'tool_use', id: 'toolu_fx_grep', name: 'Grep', input: { pattern: 'nextDelay', path: 'web/src' } },
      ],
    },
  }),
  ev('sdk', {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_fx_read', content: READ_RESULT },
        { type: 'tool_result', tool_use_id: 'toolu_fx_grep', content: 'web/src/ws.ts:912\nweb/src/lib/backoff.ts:1' },
      ],
    },
  }),
  ev('sdk', {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_fx_edit',
          name: 'Edit',
          input: {
            file_path: 'web/src/lib/backoff.ts',
            old_string: '  return Math.min(1000 * 2 ** attempt, 60_000);',
            new_string:
              '  const capped = Math.min(1000 * 2 ** attempt, 30_000);\n  return capped / 2 + Math.random() * (capped / 2);',
          },
        },
        { type: 'tool_use', id: 'toolu_fx_test', name: 'Bash', input: { command: 'npm test -w web -- backoff', description: 'Run the backoff tests' } },
      ],
    },
  }),
  ev('sdk', {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_fx_edit', content: 'The file web/src/lib/backoff.ts has been updated.' },
        { type: 'tool_result', tool_use_id: 'toolu_fx_test', content: ' ✓ backoff caps at 30s (2 ms)\n ✓ backoff adds jitter (1 ms)\n\nTests  2 passed' },
      ],
    },
  }),
  ev('sdk', {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'text',
          text:
            'Done. The reconnect delay now:\n\n- caps at **30 s** instead of 60 s\n- uses *equal jitter*, so a fleet of tabs does not reconnect in lockstep\n\n```ts\nconst capped = Math.min(1000 * 2 ** attempt, 30_000);\nreturn capped / 2 + Math.random() * (capped / 2);\n```\n\nBoth backoff tests pass.',
        },
      ],
    },
  }),
  ev('sdk', { type: 'result', subtype: 'success', is_error: false, duration_ms: 48_200, total_cost_usd: 0.11 }),
];

/** The same conversation with a second turn still running. */
export const RUNNING_EVENTS: TranscriptEvent[] = [
  ...CONVERSATION_EVENTS,
  ev('user', { text: 'Nice. Now add a test for the 1008 close path.', actor: ADA }),
  ev('sdk', {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Looking at the existing socket tests.' },
        { type: 'tool_use', id: 'toolu_fx_glob', name: 'Glob', input: { pattern: 'web/src/**/*.test.ts' } },
      ],
    },
  }),
  ev('interject', { text: 'Use the fake timers helper, not real sleeps.' }),
];

export const PENDING_BASH: PermissionRequestData = {
  requestId: 'perm_fx_migrate',
  toolName: 'Bash',
  input: { command: 'npx prisma migrate deploy', description: 'Apply pending database migrations' },
  guardReason: 'Writes to the database',
};

/** A turn stopped on a permission card. */
export const WAITING_EVENTS: TranscriptEvent[] = [
  ev('sdk', { type: 'system', subtype: 'init', model: 'claude-opus-5-5' }),
  ev('user', { text: 'Apply the new migration to my local database.' }),
  ev('sdk', {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'I will run the Prisma migration against your local database.' }] },
  }),
  ev('permission', PENDING_BASH),
];

/** A turn that failed, with the trailing Retry. */
export const FAILED_EVENTS: TranscriptEvent[] = [
  ev('sdk', { type: 'system', subtype: 'init', model: 'claude-opus-5-5' }),
  ev('user', { text: 'Bump Prisma to the latest minor and regenerate the client.' }),
  ev('sdk', {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    duration_ms: 3_400,
    result: 'API Error: 529 Overloaded',
  }),
];

export const ALL_TRANSCRIPTS: Record<string, TranscriptEvent[]> = {
  [SESSION_IDLE.id]: CONVERSATION_EVENTS,
  [SESSION_RUNNING.id]: RUNNING_EVENTS,
  [SESSION_WAITING.id]: WAITING_EVENTS,
  [SESSION_FAILED.id]: FAILED_EVENTS,
};

// ---------------------------------------------------------------------------
// The shell: a connected machine, its projects, the header's account and usage
// ---------------------------------------------------------------------------

/** The signed-in user — not Ada, who stays the collaborator in the transcripts above. */
export const OWNER = { userId: 'user_fixture_owner', name: 'Sam Okafor', email: 'sam@example.com', imageUrl: null };

export const GRACE = { userId: 'user_fixture_grace', email: 'grace@example.com', name: 'Grace Hopper', imageUrl: null };
export const LINUS = { userId: 'user_fixture_linus', email: 'linus@example.com', name: 'Linus Park', imageUrl: null };

export const DEVICE_ID = 'device-fixture-studio';
export const DEVICE_MINI = 'device-fixture-mini';
const DEVICE_SHARED = 'device-fixture-grace';

const KUBI_CWD = '/Users/dev/projects/kubi';
const SITE_CWD = '/Users/dev/projects/marketing-site';

/** Paired machines, as storage lists them (read by MachineSwitcher and SessionView's share title). */
export const FIXTURE_DEVICES = [
  {
    id: DEVICE_ID,
    name: 'Sam’s MacBook Pro',
    platform: 'darwin',
    lastSeenAt: new Date(T0 + 600_000).toISOString(),
    online: true,
  },
  {
    id: DEVICE_MINI,
    name: 'Build Mac mini',
    platform: 'darwin',
    lastSeenAt: new Date(T0 - 3 * 3_600_000).toISOString(),
    online: false,
  },
  {
    id: DEVICE_SHARED,
    name: 'Grace’s iMac',
    platform: 'darwin',
    lastSeenAt: new Date(T0 + 540_000).toISOString(),
    online: true,
    shared: true,
    scope: 'machine' as const,
    ownerProfile: GRACE,
  },
];

export const FIXTURE_PROJECTS = [
  {
    path: CWD,
    worktrees: [{ path: `${CWD}-wt/relay-retry`, branch: 'relay-retry', baseRef: 'main', createdByLines: true as const }],
  },
  { path: KUBI_CWD },
  { path: SITE_CWD },
];

export const RECENT_DIRS = [CWD, KUBI_CWD, SITE_CWD, '/Users/dev/projects/dotfiles', '/Users/dev/scratch/prisma-repro'];

/** A session in another tab that needs the user, so that tab carries a status dot. */
export const SESSION_OTHER_PROJECT: SessionMeta = {
  ...SESSION_WAITING,
  id: 'kubi-session-other-project',
  name: 'Fix grid track resize',
  cwd: KUBI_CWD,
};

export const SESSION_ARCHIVED: SessionMeta = {
  ...SESSION_IDLE,
  id: 'kubi-session-archived',
  name: 'Spike: SSE instead of WebSocket',
  createdAt: T0 - 86_400_000,
  archived: true,
};

/** A run of the three-step "Plan, build, review" workflow, on its second step. */
export const SESSION_WORKFLOW: SessionMeta = {
  ...SESSION_RUNNING,
  id: 'kubi-session-workflow',
  name: 'Offline queue for prompts',
  workflow: {
    workflowId: 'wf_fixture_pbr',
    stepIndex: 1,
    stepStatuses: ['done', 'running', 'pending'],
    started: true,
    task: 'Hold prompts typed while the link is down and send them on reconnect.',
    stepCostsUsd: [0.38],
    stepDurationsMs: [212_000],
    def: {
      id: 'wf_fixture_pbr',
      name: 'Plan, build, review',
      steps: [
        {
          name: 'Plan',
          promptTemplate: 'Read the code involved and write a plan for: {{task}}',
          model: 'claude-opus-5-5',
          permissionMode: 'plan',
          autoAdvance: false,
          freshStart: false,
          outputName: 'plan',
        },
        {
          name: 'Build',
          promptTemplate: 'Implement the approved plan:\n\n{{plan}}',
          model: 'claude-sonnet-5-5',
          permissionMode: 'acceptEdits',
          autoAdvance: true,
          freshStart: false,
        },
        {
          name: 'Review',
          promptTemplate: 'Review the diff for bugs and missing tests.',
          model: 'gpt-6-sol',
          permissionMode: 'default',
          autoAdvance: false,
          freshStart: true,
        },
      ],
    },
  },
};

/** Sessions the shell adds to the session-surface fixtures above. */
export const SHELL_SESSIONS = [SESSION_OTHER_PROJECT, SESSION_ARCHIVED, SESSION_WORKFLOW];

export const SHELL_TRANSCRIPTS: Record<string, TranscriptEvent[]> = {
  [SESSION_WORKFLOW.id]: RUNNING_EVENTS,
  [SESSION_OTHER_PROJECT.id]: WAITING_EVENTS,
  [SESSION_ARCHIVED.id]: CONVERSATION_EVENTS,
};

const HOUR = 3_600_000;

export const CLAUDE_USAGE = {
  windows: [
    { id: 'five_hour', utilization: 34, resetsAt: new Date(T0 + 2 * HOUR).toISOString() },
    { id: 'seven_day', utilization: 61, resetsAt: new Date(T0 + 3 * 24 * HOUR).toISOString() },
    { id: 'seven_day_opus', utilization: 78, resetsAt: new Date(T0 + 3 * 24 * HOUR).toISOString() },
  ],
  fetchedAt: T0 + 600_000,
  plan: 'Max',
};

export const CLAUDE_USAGE_NEAR_LIMIT = {
  ...CLAUDE_USAGE,
  windows: [
    { id: 'five_hour', utilization: 96, resetsAt: new Date(T0 + 40 * 60_000).toISOString() },
    { id: 'seven_day', utilization: 88, resetsAt: new Date(T0 + 3 * 24 * HOUR).toISOString() },
  ],
};

export const OPENAI_USAGE = {
  windows: [
    { id: 'primary', label: '5-hour limit', utilization: 12, resetsAt: new Date(T0 + 4 * HOUR).toISOString() },
    { id: 'secondary', label: 'Weekly', utilization: 27, resetsAt: new Date(T0 + 5 * 24 * HOUR).toISOString() },
  ],
  fetchedAt: T0 + 600_000,
  plan: 'Pro',
};

export const CLAUDE_AUTH = { loggedIn: true, account: { email: OWNER.email } };
export const OPENAI_AUTH = { loggedIn: true, account: { email: OWNER.email } };

/** The primary machine's slice: linked, bootstrapped, healthy, on this computer. */
export const MACHINE_SLICE = {
  deviceId: DEVICE_ID,
  scope: 'owner' as const,
  connectionStatus: 'connected' as const,
  machineOffline: false,
  bootstrapped: true,
  worker: { connected: true, version: '0.1.24' },
  storage: { available: true },
  update: null,
  bridge: { version: '0.1.24', appProtocol: 6 },
  claudeCli: null,
  codexCli: null,
  whisper: null,
  ownerProfile: null,
  local: true,
  encrypted: true,
  push: false,
  view: {
    projects: FIXTURE_PROJECTS,
    projectKeys: {},
    recentDirs: RECENT_DIRS,
    workflows: [],
    sharedWorkflows: [],
    steps: [],
    sharedSteps: [],
    pinnedSteps: [],
    recipes: [],
    sharedRecipes: [],
    recipeStats: {},
    models: FIXTURE_MODELS,
    usage: CLAUDE_USAGE,
    openaiUsage: OPENAI_USAGE,
    auth: CLAUDE_AUTH,
    openaiAuth: OPENAI_AUTH,
    access: null,
    guardAllowlist: [],
    guardReview: null,
    memoryReview: null,
    mcpConnections: [],
    mcpReview: null,
  },
};

/** Who else is looking at the idle session: Grace is typing, Linus is reading. */
export const PRESENCE = {
  [SESSION_IDLE.id]: [
    { userId: GRACE.userId, connId: 'conn-grace', profile: GRACE, viewing: true, focused: true, lastSeenAt: T0 + 590_000 },
    { userId: LINUS.userId, connId: 'conn-linus', profile: LINUS, viewing: true, focused: false, lastSeenAt: T0 + 580_000 },
  ],
};

/**
 * The connected shell, as the store holds it after `hello`: one machine linked
 * and healthy, the Lines project open, the idle session selected. The banner
 * fields are the healthy defaults; stories override them per instance through
 * `parameters.store` (see kubi.config).
 */
export const SHELL_STATE = {
  primaryDeviceId: DEVICE_ID,
  machines: { [DEVICE_ID]: MACHINE_SLICE },
  // Every fixture session is stamped to this machine, as `hello` stamps them.
  sessionMachine: Object.fromEntries([...ALL_SESSIONS, ...SHELL_SESSIONS].map((s) => [s.id, DEVICE_ID])),
  machineOffline: false,
  projects: FIXTURE_PROJECTS,
  projectKeys: {},
  recentDirs: RECENT_DIRS,
  activeProject: CWD,
  selectedSessionId: SESSION_IDLE.id,
  presence: PRESENCE,
  usage: CLAUDE_USAGE,
  openaiUsage: OPENAI_USAGE,
  auth: CLAUDE_AUTH,
  openaiAuth: OPENAI_AUTH,
  workerStatus: { connected: true, version: '0.1.24' },
  storageStatus: { available: true },
  updateStatus: null,
  bridge: { version: '0.1.24', appProtocol: 6 },
  protocolSkew: false,
};

/** Search results for "backoff", as the bridge answers a sidebar search. */
export const SEARCH_RESULTS = {
  sessions: [
    {
      sessionId: SESSION_IDLE.id,
      matches: [
        { seq: 2, text: 'The relay reconnect backoff never resets after a 1008 close.', start: 20, end: 27 },
        { seq: 8, text: 'Done. The reconnect backoff now caps at 30 s; both backoff tests pass.', start: 20, end: 27 },
      ],
    },
    {
      sessionId: SESSION_RUNNING.id,
      matches: [{ seq: 3, text: 'Looking at how backoff is reset after a successful dial.', start: 15, end: 22 }],
    },
  ],
};
