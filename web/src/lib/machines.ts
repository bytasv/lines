import type {
  AuthStatus,
  BridgeInfo,
  ClaudeCliStatus,
  CodexCliStatus,
  WhisperStatus,
  GuardAllowEntry,
  GuardAllowlistReview,
  McpConnection,
  McpConnectionsReview,
  MemoryReview,
  ModelOption,
  Project,
  ProjectKeyMap,
  RecipeDef,
  ServerMessage,
  SessionMeta,
  ShareProfile,
  ShareScope,
  InlineStep,
  StepContent,
  StepDef,
  StorageStatus,
  UpdateStatus,
  UsageSnapshot,
  WorkerStatus,
  WorkflowDef,
} from '@lines/shared';
import { isStepRef, projectPaths } from '@lines/shared';

/**
 * Per-machine state and the merge rules that keep two machines' sessions apart.
 *
 * Free of React and the store on purpose. These are the reducers that a
 * single-machine client got away with doing wholesale — replace the session map,
 * prune every draft that has no session — and each of them silently destroys
 * another machine's state once two are held at once. Pure functions so they can
 * be tested directly; the store only supplies them with its current state.
 */

export type ConnectionState = 'connected' | 'reconnecting' | 'offline';

/** The `hello` frame, as the wire declares it. */
type Hello = Extract<ServerMessage, { type: 'hello' }>;

/** The `access` block only a guest's `hello` carries; see `GuestAccess` in the store. */
type Access = NonNullable<Hello['access']>;

/**
 * The owner-state half of one machine's `hello`.
 *
 * The bridge already sends a *thin* `hello` to a guest — a shared machine
 * contributes sessions and nothing else — so a client holding two links at once
 * must never merge two of these. Before this existed the reducer wrote every
 * field below straight into the globals whichever machine spoke last, so a
 * shared machine's hello blanked the projects, the library and the account of
 * the machine the user was actually looking at, and the next own-machine hello
 * put them back: the sidebar flicker.
 *
 * Kept as one nested field on the slice rather than twenty-odd parallel ones so
 * "everything a machine switch has to swap" is a single value. Every field is
 * named exactly as its counterpart in the store, so spreading a view *is* the
 * projection onto the globals — the reducer and `setPrimaryMachine` cannot drift
 * apart about which fields belong to a machine, which is the one real hazard of
 * scoping them.
 */
export interface MachineView {
  projects: Project[];
  projectKeys: ProjectKeyMap;
  recentDirs: string[];
  workflows: WorkflowDef[];
  sharedWorkflows: WorkflowDef[];
  steps: StepDef[];
  sharedSteps: StepDef[];
  pinnedSteps: StepDef[];
  recipes: RecipeDef[];
  sharedRecipes: RecipeDef[];
  recipeStats: Record<string, number>;
  models: ModelOption[];
  usage: UsageSnapshot | null;
  openaiUsage: UsageSnapshot | null;
  auth: AuthStatus | null;
  openaiAuth: AuthStatus | null;
  /** Non-null means this machine is somebody else's. */
  access: Access | null;
  guardAllowlist: GuardAllowEntry[];
  guardReview: GuardAllowlistReview | null;
  memoryReview: MemoryReview | null;
  mcpConnections: McpConnection[];
  mcpReview: McpConnectionsReview | null;
}

/** A machine nothing is known about yet: empty everywhere, never "logged out". */
export const emptyView = (): MachineView => ({
  projects: [],
  projectKeys: {},
  recentDirs: [],
  workflows: [],
  sharedWorkflows: [],
  steps: [],
  sharedSteps: [],
  pinnedSteps: [],
  recipes: [],
  sharedRecipes: [],
  recipeStats: {},
  models: [],
  usage: null,
  openaiUsage: null,
  auth: null,
  openaiAuth: null,
  access: null,
  guardAllowlist: [],
  guardReview: null,
  memoryReview: null,
  mcpConnections: [],
  mcpReview: null,
});

/** Everything the client knows about one machine it is holding a link to. */
export interface MachineSlice {
  deviceId: string;
  /** Owner of the machine, or the grant that reaches it. */
  scope: ShareScope;
  connectionStatus: ConnectionState;
  /** The relay says no bridge is attached — a fact, distinct from a dead link. */
  machineOffline: boolean;
  /** A `hello` has landed, so this machine's slice describes something real. */
  bootstrapped: boolean;
  worker: WorkerStatus | null;
  storage: StorageStatus | null;
  /** Desktop update this machine is offering; null until a `hello` or transition says so. */
  update: UpdateStatus | null;
  /** Which bridge this machine is running; null until its `hello`, and on a bridge
   *  too old to send the field — which is itself skew (see SkewBanner). Per-machine
   *  because the pill describes the machine in front of the user, and two links can
   *  be held at once. */
  bridge: BridgeInfo | null;
  /** The Claude Code CLI this machine runs turns with; null until its `hello`,
   *  and on a bridge too old to send the field. Per-machine like `bridge`: it
   *  describes the machine, and two links can be held at once. */
  claudeCli: ClaudeCliStatus | null;
  /** The Codex CLI on this machine, on the same terms as `claudeCli`. */
  codexCli: CodexCliStatus | null;
  /** This machine's voice-input transcriber. Guests are sent it too: a shared
   *  session's dictation is transcribed on the machine that hosts it. */
  whisper: WhisperStatus | null;
  /** Whose machine it is, when it is not ours. */
  ownerProfile: ShareProfile | null;
  /**
   * Whether this link reaches the bridge from the machine the bridge runs on.
   * Locality is a property of a *link* — the client holds several at once — so
   * it lives here rather than in a global flag. False until a `hello` says
   * otherwise, and on a bridge too old to send the field: a control that would
   * open a window on somebody else's desk fails closed.
   */
  local: boolean;
  /**
   * Whether this link is end-to-end encrypted against a key this browser pinned,
   * rather than merely TLS-protected as far as a relay the machine has to trust.
   * False until a `hello` says otherwise, and on a bridge too old to say.
   */
  encrypted: boolean;
  /** This bridge accepts `registerPush`; false until a `hello` says so, and on a
   *  bridge too old to — which would refuse the message with a visible error. */
  push: boolean;
  /**
   * The owner state this machine's last `hello` described. Held per machine
   * because only the primary's copy may reach the globals — see {@link MachineView}.
   */
  view: MachineView;
}

export const emptyMachine = (deviceId: string): MachineSlice => ({
  deviceId,
  scope: 'owner',
  connectionStatus: 'reconnecting',
  machineOffline: false,
  bootstrapped: false,
  worker: null,
  storage: null,
  update: null,
  bridge: null,
  claudeCli: null,
  codexCli: null,
  whisper: null,
  ownerProfile: null,
  local: false,
  encrypted: false,
  push: false,
  view: emptyView(),
});

/**
 * This machine's owner state, folded from its `hello`.
 *
 * `prev` is that machine's *own* previous view, never the globals: the two
 * carry-forward rules below are about one bridge restarting, and reading them
 * from global state made a second machine's hello inherit the first's chip.
 */
export function machineView(msg: Hello, prev: MachineView): MachineView {
  const projectKeys = msg.projectKeys ?? {};
  return {
    // A session share is sent no project list — it has no folder of its own —
    // so its tabs are built from the sessions shared with it. A machine share is
    // sent the host's real list; an older host bridge sends it none, and falls
    // back the same way. Without this, switching to a shared machine left no tab
    // to select and nothing listed.
    projects:
      msg.access && msg.projects.length === 0
        ? guestProjects(msg.sessions, projectKeys)
        : // `hello` carries no protocol version, so a tab left open across the
          // upgrade — or an old bridge — can still send bare path strings here.
          (msg.projects as (Project | string)[]).map((p) =>
            typeof p === 'string' ? { path: p } : p,
          ),
    projectKeys,
    recentDirs: msg.recentDirs,
    workflows: msg.workflows,
    sharedWorkflows: msg.sharedWorkflows ?? [],
    steps: msg.steps ?? [],
    sharedSteps: msg.sharedSteps ?? [],
    pinnedSteps: msg.pinnedSteps ?? [],
    recipes: msg.recipes ?? [],
    sharedRecipes: msg.sharedRecipes ?? [],
    recipeStats: msg.recipeStats ?? {},
    models: msg.models,
    // A bridge restart sends hello before its first usage fetch completes; keep
    // the last good snapshot rather than flickering the chip away — but drop it
    // once the account behind it is gone.
    usage: msg.usage ?? (msg.auth.loggedIn ? prev.usage : null),
    // Same rule as `usage`, against the OpenAI account.
    openaiUsage: msg.openaiUsage ?? (msg.openaiAuth?.loggedIn ? prev.openaiUsage : null),
    auth: msg.auth,
    // Absent on a bridge older than this field — degrades to "no OpenAI account",
    // which is exactly what such a bridge can offer.
    openaiAuth: msg.openaiAuth ?? { loggedIn: false },
    // Present only from somebody else's machine. Absent means our own, so it
    // must reset rather than persist from a previous connection.
    access: msg.access ?? null,
    guardAllowlist: msg.guardAllowlist ?? [],
    guardReview: msg.guardAllowlistReview ?? null,
    memoryReview: msg.memoryReview ?? null,
    mcpConnections: msg.mcpConnections ?? [],
    mcpReview: msg.mcpConnectionsReview ?? null,
  };
}

/**
 * Project tabs for a machine shared with us, derived from its shared sessions.
 *
 * Reveals nothing the guest does not already hold: every path here is a shared
 * session's `cwd`. Sessions whose folders share a project key (a work tree and
 * its repo, say) collapse into one tab named after the shortest path, which is
 * the one `sessionsInProject` then matches the rest against by key.
 */
export function guestProjects(sessions: SessionMeta[], projectKeys: ProjectKeyMap): Project[] {
  const byKey = new Map<string, string>();
  for (const { cwd } of sessions) {
    if (!cwd) continue;
    const key = projectKeys[cwd] ?? cwd;
    const current = byKey.get(key);
    if (!current || cwd.length < current.length) byKey.set(key, cwd);
  }
  return [...byKey.values()].sort().map((path) => ({ path }));
}

/**
 * The sessions hosted by one machine.
 *
 * The store holds every linked machine's sessions on purpose — messages route by
 * `sessionMachine`, and alerts fire for all of them — so this is a *display*
 * scope, applied where a list would otherwise mix two computers together.
 *
 * A direct local bridge stamps `''` and has no device id at all, so callers pass
 * `primaryDeviceId ?? ''` and a local install is unaffected. An unstamped
 * session — one no `hello` has claimed yet — is shown on the machine being asked
 * about rather than hidden: the same "keep rather than guess" rule
 * `mergeMachineSessions` follows, and a session rendered nowhere is worse than
 * one rendered here.
 */
export function sessionsOnMachine(
  sessions: Record<string, SessionMeta>,
  sessionMachine: Record<string, string>,
  deviceId: string,
): Record<string, SessionMeta> {
  const out: Record<string, SessionMeta> = {};
  for (const [id, session] of Object.entries(sessions)) {
    if ((sessionMachine[id] ?? deviceId) === deviceId) out[id] = session;
  }
  return out;
}

/**
 * Fold one machine's `hello` into a session map that may hold several machines'
 * sessions.
 *
 * The single-machine version replaced the whole map. Doing that with two links
 * open means whichever machine said `hello` last wins and the other's sessions
 * vanish from the sidebar — so this drops only the sessions *stamped to this
 * machine* that the machine no longer reports, and leaves every other stamp
 * alone.
 *
 * Unstamped sessions are adopted by the machine whose hello mentions them: on a
 * first connection nothing is stamped yet, and on an upgrade from a
 * single-machine client the existing map has no stamps at all.
 */
export function mergeMachineSessions(input: {
  sessions: Record<string, SessionMeta>;
  sessionMachine: Record<string, string>;
  deviceId: string;
  incoming: SessionMeta[];
}): { sessions: Record<string, SessionMeta>; sessionMachine: Record<string, string> } {
  const live = new Set(input.incoming.map((s) => s.id));
  const sessions: Record<string, SessionMeta> = {};
  const sessionMachine: Record<string, string> = {};

  for (const [id, session] of Object.entries(input.sessions)) {
    const owner = input.sessionMachine[id];
    // Another machine's session: untouched, whatever this hello says.
    if (owner && owner !== input.deviceId) {
      sessions[id] = session;
      sessionMachine[id] = owner;
      continue;
    }
    // Ours (or unstamped) and still reported: the incoming copy wins below.
    // Ours and absent from the hello: gone on that machine, so dropped here.
    if (live.has(id)) continue;
    if (!owner) {
      // Unstamped and unclaimed by this hello. Keep it rather than guessing —
      // it may belong to a machine whose link has not opened yet, and dropping
      // it would make sessions flicker out on every reconnect.
      sessions[id] = session;
    }
  }

  for (const session of input.incoming) {
    sessions[session.id] = session;
    sessionMachine[session.id] = input.deviceId;
  }
  return { sessions, sessionMachine };
}

/**
 * Which stored drafts this machine's `hello` may delete.
 *
 * The rule that matters is what it *excludes*. A draft is only prunable when we
 * positively know it belonged to a session on this machine that the machine no
 * longer has. A draft for a session id we have never seen — another machine's,
 * one whose link is not open yet — is left alone: unscoped pruning here deletes
 * text the user typed and has not sent, which is unrecoverable.
 */
export function prunableDraftIds(input: {
  draftIds: string[];
  sessionMachine: Record<string, string>;
  deviceId: string;
  /** Session ids this machine just reported. */
  live: Set<string>;
}): string[] {
  return input.draftIds.filter(
    (id) => input.sessionMachine[id] === input.deviceId && !input.live.has(id),
  );
}

/**
 * Whether a session arriving in an upsert should steal the selection.
 *
 * Two pre-existing halves, unchanged: this client must have asked for a session
 * (`pendingCreate`), and the session must be one it has never seen — `createdAt`
 * is stamped on the bridge machine, so a clock even slightly ahead made every
 * upsert look freshly created and any session re-entering the map stole the view.
 *
 * The multi-machine half is `fromPrimary`. Without it, the host creating a
 * session on their own laptop yanks a guest's view across to it mid-sentence,
 * because the guest's client is holding that machine's link too.
 */
export function shouldClaimSelection(input: {
  fromPrimary: boolean;
  pendingCreate: boolean;
  alreadySeen: boolean;
}): boolean {
  return input.fromPrimary && input.pendingCreate && !input.alreadySeen;
}

/**
 * Whether a session belongs to a project tab — every one of its paths, matched by
 * project key when that checkout has one. The single membership rule behind the
 * store's `sessionsInProject`; see there for why keys and `projectPaths`.
 */
export function inProject(
  session: Pick<SessionMeta, 'cwd'>,
  projectKeys: ProjectKeyMap,
  project: Project,
): boolean {
  const paths = projectPaths(project);
  if (paths.includes(session.cwd)) return true;
  const key = projectKeys[session.cwd];
  return key != null && paths.some((p) => projectKeys[p] === key);
}

/**
 * Where a notification click has to take the UI for this session: the machine
 * hosting it, and the project tab it belongs to on that machine.
 *
 * The machine's own view, not the globals: when the session is on a non-primary
 * machine, the globals describe the machine being left. `projectPath` is null when
 * no open tab claims the session — the caller then selects it where it stands.
 */
export function alertTarget(input: {
  sessionId: string;
  sessions: Record<string, SessionMeta>;
  sessionMachine: Record<string, string>;
  machines: Record<string, MachineSlice>;
  primaryDeviceId: string | null;
  /** The globals, used when the target machine has no slice (a direct local bridge). */
  projects: Project[];
  projectKeys: ProjectKeyMap;
}): { deviceId: string; switchMachine: boolean; projectPath: string | null } | null {
  const session = input.sessions[input.sessionId];
  if (!session) return null;
  const primary = input.primaryDeviceId ?? '';
  const deviceId = input.sessionMachine[input.sessionId] ?? primary;
  const switchMachine = deviceId !== primary;
  const view = switchMachine ? input.machines[deviceId]?.view : undefined;
  const projects = view?.projects ?? input.projects;
  const projectKeys = view?.projectKeys ?? input.projectKeys;
  const project = projects.find((p) => inProject(session, projectKeys, p)) ?? null;
  return { deviceId, switchMachine, projectPath: project?.path ?? null };
}

/** Only the runnable fields of a step — its library identity stays behind. */
function contentOf(step: StepContent): StepContent {
  const { name, promptTemplate, model, permissionMode, reasoningEffort, routing, autoAdvance, freshStart, outputName } =
    step;
  return {
    name,
    promptTemplate,
    model,
    permissionMode,
    autoAdvance,
    freshStart,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(routing !== undefined ? { routing } : {}),
    ...(outputName !== undefined ? { outputName } : {}),
  };
}

/**
 * A self-contained copy of one of the user's own workflows, every `StepRef`
 * swapped for its content, so it can run on a machine that has none of their
 * step library (a shared machine). Refs resolve the way `useStepResolver` does —
 * the exact pin first, else that step's latest version known here. Null when a
 * ref cannot be resolved: running a workflow with a step missing is worse than
 * not starting it.
 */
export function inlineWorkflow(
  def: WorkflowDef,
  steps: StepDef[],
  pinned: StepDef[],
  shared: StepDef[] = [],
): WorkflowDef | null {
  const all = [...pinned, ...steps, ...shared];
  const out: InlineStep[] = [];
  for (const step of def.steps) {
    if (!isStepRef(step)) {
      out.push(step);
      continue;
    }
    const found =
      all.find((d) => d.ownerId === step.ownerId && d.id === step.stepId && d.version === step.version) ??
      all.find((d) => d.ownerId === step.ownerId && d.id === step.stepId);
    if (!found) return null;
    out.push(contentOf(found));
  }
  return { ...def, steps: out };
}
