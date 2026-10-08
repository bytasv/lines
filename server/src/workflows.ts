import { randomUUID } from 'node:crypto';
import type {
  Actor,
  FileChange,
  PromptAttachment,
  ServerMessage,
  SessionMeta,
  RoutingRule,
  StepContent,
  StepDef,
  StepRef,
  UntrustedMark,
  WorkflowDef,
  WorkflowMarkerData,
  WorkflowState,
  WorkflowStepOverride,
} from '@lines/shared';
import {
  isSessionActive,
  isSessionInterruptible,
  isStepRef,
  providerForModel,
  providerSwitchNeedsFreshStart,
  resolveModelId,
  rootsForCwd,
  sanitizeStepOverrides,
} from '@lines/shared';
import type { Store } from './store.ts';
import type { SessionManager } from './sessions.ts';
import { isHeld, ItemTrust, markAfterSave, runnableDigest, settledHold, unmarked, vouchedFor } from './syncSignature.ts';
import {
  captureBaselines,
  changedFiles,
  groupByRepo,
  multiRepoDiff,
  repoBranch,
  type RepoBaseline,
  type RepoGroup,
} from './git.ts';

const stepKey = (ownerId: string, id: string, version: number) => `${ownerId}/${id}/${version}`;

/** True when two step contents are identical (version bumps only on content change). */
function sameContent(a: StepContent, b: StepContent): boolean {
  return (
    a.name === b.name &&
    a.promptTemplate === b.promptTemplate &&
    a.model === b.model &&
    a.permissionMode === b.permissionMode &&
    // Optional-field idiom, as `outputName` below: without this line a step whose
    // only edit is its reasoning effort never mints a new version.
    (a.reasoningEffort ?? '') === (b.reasoningEffort ?? '') &&
    a.autoAdvance === b.autoAdvance &&
    a.freshStart === b.freshStart &&
    (a.outputName ?? '') === (b.outputName ?? '') &&
    // Same idiom for the routing rule: a routing-only edit must mint a version.
    stableJson(a.routing) === stableJson(b.routing)
  );
}

/** JSON with object keys sorted, so two equal values compare equal whatever
 *  order their keys were written in. `undefined` stays `undefined`. */
function stableJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)))
      : v,
  );
}

/**
 * Whether two workflow revisions would run the same thing. Compares the step
 * list only — a rename or a description edit is not an instruction change, and
 * holding those back while a run is in flight would be noise.
 */
function sameSteps(a: WorkflowDef, b: WorkflowDef): boolean {
  return JSON.stringify(a.steps) === JSON.stringify(b.steps);
}

/**
 * Merge rule for `createdAt` at every layer: earliest wins. Idempotent and
 * order-independent, so two peers converge whichever way round their pushes
 * land — and a blob that dropped the field can never erase a known birthday.
 */
function earliest(...values: (number | undefined)[]): number | undefined {
  let out: number | undefined;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (out === undefined || v < out) out = v;
  }
  return out;
}

/**
 * True when a template threads the hand-off in itself — via `{previous}`/`{diff}`/
 * `{changed}` or any `{outputs.*}` — so `runStep` must not also auto-prepend it.
 * Tested against the template: after substitution the tokens are gone.
 *
 * `{roots}` is deliberately NOT here: it is static workspace shape, not a
 * hand-off, so a template using only `{roots}` should still get the auto-prepend.
 * `{changed}` is: it is this run's own change set, so a template carrying it must
 * not also get the `## Changes so far (git diff)` block.
 */
export function usesHandoffTokens(template: string): boolean {
  return /\{previous\}|\{diff\}|\{changed\}|\{outputs\./.test(template);
}

const TOKEN_RE = /\{(task|feedback|previous|diff|changed|roots|outputs\.[\w-]+)\}/g;

/** Cheap pre-checks so a template that never mentions a token costs no git calls. */
const USES_ROOTS_RE = /\{roots\}/;
const USES_DIFF_RE = /\{diff\}/;
const USES_CHANGED_RE = /\{changed\}/;

/** What a step reads when `{diff}` resolves to nothing — never a silent gap. */
const NO_DIFF = 'No tracked changes since this workflow run started.';
const NO_CHANGES = 'No files changed since this workflow run started.';

/**
 * The workspace as a step needs to understand it: which folders are in scope,
 * which work tree each belongs to, and therefore how many commits the work can
 * produce. Formatting lives here rather than in git.ts, which stays pure git.
 *
 * Bash never leaves the session's cwd — `additionalDirectories` grants file-tool
 * access, not a shell — so the `git -C` instruction is the whole point of this
 * block: without it a step's bare `git status` silently sees only one repo.
 */
function renderRoots(
  repos: RepoGroup[],
  orphans: string[],
  branches: Map<string, string | null>,
  cwd: string,
): string {
  const lines: string[] = ['# Workspace roots', ''];
  for (const repo of repos) {
    for (const root of repo.roots) {
      const branch = branches.get(repo.root);
      const primary = root === cwd ? 'primary, session cwd; ' : '';
      lines.push(`- ${root} — ${primary}repo ${repo.root}${branch ? ` (${branch})` : ''}`);
    }
  }
  for (const root of orphans) {
    lines.push(`- ${root} — ${root === cwd ? 'primary, session cwd; ' : ''}not a git repository`);
  }
  lines.push(
    '',
    `${repos.length} commit unit${repos.length === 1 ? '' : 's'}. Bash runs in the primary root, so scope every git command`,
    'with `git -C <repo root>`.',
  );
  return lines.join('\n');
}

/** One commit unit's change set, as `renderChanged` needs it. */
export interface ChangedRepo {
  repo: string;
  branch: string | null;
  /** Where the floor came from — see `SessionManager.baselinesFor`. */
  baseline: 'session' | 'workflow' | 'synthetic' | 'stale';
  files: FileChange[];
  /** New files past the per-repo listing cap, i.e. missing from `files`. */
  untrackedOmitted: number;
}

/**
 * Every file this run changed, per commit unit — the authoritative set a commit
 * step stages from. Unlike `{diff}` this is never char-truncated: `MAX_DIFF_CHARS`
 * cuts mid-text, so a large run loses whole `diff --git` headers and the files
 * behind them disappear, path and all. A path list stays small enough not to need
 * a cap, so a file can only go missing here for a reason this text names out loud.
 *
 * Statuses are git's own `A`/`M`/`D`, and paths are repo-relative, so a line maps
 * straight onto `git -C <repo> add -- <path>`. Formatting lives here rather than in
 * git.ts, which stays pure git.
 */
export function renderChanged(repos: ChangedRepo[]): string {
  if (!repos.length) return NO_CHANGES;
  // A single repo emits no `# repo:` header, mirroring multiRepoDiff.
  const single = repos.length === 1;
  return repos
    .map((r) => {
      const lines: string[] = [];
      if (!single) lines.push(`# repo: ${r.repo}${r.branch ? ` (${r.branch})` : ''}`, '');
      for (const f of r.files) lines.push(`${f.status} ${f.rel}`);
      if (r.files.length) lines.push('');
      // An empty change set is a legitimate outcome, so it gets a sentence rather
      // than the blank a step would read as "the list failed to render".
      lines.push(
        r.files.length
          ? `${r.files.length} file${r.files.length === 1 ? '' : 's'} changed since this workflow run started.`
          : NO_CHANGES,
      );
      if (r.untrackedOmitted > 0) {
        lines.push(
          `WARNING: ${r.untrackedOmitted} further new file${r.untrackedOmitted === 1 ? ' is' : 's are'} present but past the listing cap — this list is INCOMPLETE.`,
        );
      }
      if (r.baseline === 'synthetic' || r.baseline === 'stale') {
        lines.push(
          'WARNING: no baseline was recorded for this run, so the list above is the whole uncommitted state of the repo and may include changes made before it started.',
        );
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * Fill every prompt token in ONE pass over the template. Single-pass is the whole
 * point: staged `replaceAll`s rescan text they just inserted, so a step output that
 * merely *mentions* `{previous}`/`{diff}` (a plan about this very feature, say) gets
 * those tokens expanded too — six literal `{previous}` in a plan meant the plan was
 * pasted seven times and the diff thirty-five, blowing a 3.8 MB prompt past the
 * context limit. `String.replace` never rescans replacement text, so substituted
 * content stays inert.
 *
 * `{outputs.<name>}` resolving to nothing — absent, or present but blank — is
 * reported rather than collapsed to '' silently, which is how a step ends up running
 * without the plan it asked for and improvising from whatever it finds on disk.
 */
export function substituteTokens(
  template: string,
  values: {
    task: string;
    feedback: string;
    previous: string;
    diff: string;
    changed: string;
    roots: string;
  },
  outputs: Record<string, string>,
): { prompt: string; missing: string[] } {
  const missing: string[] = [];
  const prompt = template.replace(TOKEN_RE, (_m, token: string) => {
    if (!token.startsWith('outputs.')) return values[token as keyof typeof values];
    const name = token.slice('outputs.'.length);
    const value = outputs[name];
    if (!value || !value.trim()) {
      if (!missing.includes(name)) missing.push(name);
      return '';
    }
    return value;
  });
  return { prompt, missing };
}

export const DEFAULT_WORKFLOW: WorkflowDef = {
  id: 'default-feature-flow',
  name: 'Plan → MVP → Tests → Refactor → Review',
  steps: [
    {
      name: 'Plan',
      promptTemplate:
        'We are starting a new feature: {task}\n\nFirst, explore the codebase and produce a concise implementation plan. Do not write any code yet — plan only. Ask clarifying questions if the goal is ambiguous.{feedback}',
      model: 'claude-opus-5-5',
      permissionMode: 'plan',
      autoAdvance: false,
      freshStart: false,
    },
    {
      name: 'Implement MVP',
      promptTemplate:
        'Implement the MVP of the planned feature now. Follow the approved plan as supplied in this prompt — that text is the whole plan; never go looking for plan files under ~/.claude/plans/ (they belong to other sessions). Keep the change minimal — no extras beyond the plan.{feedback}',
      model: 'claude-opus-5-5',
      permissionMode: 'auto',
      autoAdvance: false,
      freshStart: true,
    },
    {
      name: 'Add tests',
      promptTemplate:
        'Add tests covering the feature just implemented. Run them and make sure they pass.{feedback}',
      model: 'claude-sonnet-5-5',
      permissionMode: 'auto',
      autoAdvance: false,
      freshStart: true,
    },
    {
      name: 'Refactor',
      promptTemplate:
        'Refactor the new code for clarity and consistency with the rest of the codebase. Keep tests green.{feedback}',
      model: 'claude-sonnet-5-5',
      permissionMode: 'auto',
      autoAdvance: false,
      freshStart: true,
    },
    {
      name: 'Review',
      promptTemplate:
        'Do a final review of everything changed in this session. Look for correctness bugs, missed edge cases, and quality issues. Report findings; do not change code.{feedback}',
      model: 'claude-opus-5-5',
      permissionMode: 'plan',
      autoAdvance: false,
      freshStart: true,
    },
  ],
};

/**
 * Thrown by {@link WorkflowEngine.save} for an id that belongs to another user's
 * published workflow. It used to return the input unchanged, which made a
 * dropped write indistinguishable from a successful one — both to the MCP tool
 * surface and to the browser, which then rendered "Saved".
 */
export class ForeignWorkflowError extends Error {
  constructor(workflowId: string) {
    super(`Workflow ${workflowId} belongs to another user and is read-only here — duplicate it first.`);
    this.name = 'ForeignWorkflowError';
  }
}

/**
 * Thrown by {@link WorkflowEngine.assertRunnable} for a workflow that would run
 * content this machine has not verified: its own row, or a step version it pins,
 * arrived unsigned, forged or from a machine the account does not trust — or is
 * another user's and not reviewed here yet.
 */
export class UntrustedWorkflowError extends Error {
  constructor(name: string) {
    super(
      `“${name}” runs content this machine has not verified. Open it in Workflows, review what it runs, ` +
        'and allow it before running it.',
    );
    this.name = 'UntrustedWorkflowError';
  }
}

/** One piece of a workflow's run that is still held back (see `untrustedParts`). */
export interface UntrustedPart {
  kind: 'workflow' | 'step';
  ownerId: string;
  id: string;
  version?: number;
  name: string;
  mark: UntrustedMark;
}

/**
 * A mark loaded from disk, re-settled for this process and the account's trusted
 * machines now (see `settledHold`) — which is what makes a revoked key's items
 * held back again on the next load. Mutates in place, before anything reads it.
 */
function reheld<T extends { untrusted?: UntrustedMark }>(item: T, trustedSigners: ReadonlySet<string>): T {
  if (item.untrusted) item.untrusted = settledHold(item.untrusted, trustedSigners);
  return item;
}

/**
 * `item` with its mark re-settled against `trustedSigners`, or the same object
 * when nothing about whether it is held back changed.
 */
function resettled<T extends { untrusted?: UntrustedMark }>(item: T, trustedSigners: ReadonlySet<string>): T {
  if (!item.untrusted) return item;
  const mark = settledHold(item.untrusted, trustedSigners);
  return mark.held === item.untrusted.held ? item : { ...item, untrusted: mark };
}

/** Lazily read trust state for one batch of items: each file read at most once, and only if needed. */
interface TrustBatch {
  approvals: () => Record<string, string>;
  signers: () => ReadonlySet<string>;
}

export class WorkflowEngine {
  private workflows = new Map<string, WorkflowDef>();
  /** Other users' published workflows — read-only, never persisted or pushed. */
  private shared = new Map<string, WorkflowDef>();
  /** This user's own published step heads, keyed by step id. */
  private steps = new Map<string, StepDef>();
  /** Other users' published step heads (the library), keyed `${ownerId}/${id}`. */
  private sharedSteps = new Map<string, StepDef>();
  /** Every resolved immutable version (own history + resolved foreign pins), keyed by stepKey. */
  private stepVersions = new Map<string, StepDef>();
  /** Which machine keys and which reviewed foreign content this account trusts. */
  private trust: ItemTrust;
  /** Grace period a force-advance gives the interrupted turn to settle on its own
   *  before the watchdog advances the step anyway. A field so tests can shrink it. */
  forceAdvanceSettleMs = 5_000;
  /** Armed watchdogs, keyed by session (see armSettleWatchdog). */
  private settleWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

  devReloadBlockers(): string[] {
    return this.settleWatchdogs.size ? ['workflow continuation scheduled'] : [];
  }


  constructor(
    private store: Store,
    private sessions: SessionManager,
    private broadcast: (msg: ServerMessage) => void,
    /** Owner's Clerk userId, stamped onto workflows this user saves. */
    private userId: string,
  ) {
    this.trust = ItemTrust.forStore(store.rootDir);
    // Marks are re-settled on the way in (`reheld`): whether one holds its item
    // back depends on this process's strictness and the machines trusted now,
    // not on whatever was true when the file was written.
    const trusted = this.trust.trustedSigners();
    for (const wf of this.store.loadWorkflows()) this.workflows.set(wf.id, reheld(wf, trusted));
    for (const s of this.store.loadSteps()) {
      this.steps.set(s.id, reheld(s, trusted));
      this.stepVersions.set(stepKey(s.ownerId, s.id, s.version), s);
    }
    // Restore the full immutable history (heads are already in above; older versions add on).
    for (const s of this.store.loadStepVersions()) {
      this.stepVersions.set(stepKey(s.ownerId, s.id, s.version), reheld(s, trusted));
    }
    // Heal refs whose ownerId drifted from this user's id before anything reads
    // them: a drifted ref resolves nowhere, so its step renders as owned yet is
    // never offered its new version (see normalizeRefs).
    let healed = false;
    for (const wf of this.workflows.values()) if (this.normalizeRefs(wf)) healed = true;
    // Rows written before creation time was recorded get one now, from the best
    // evidence on disk: the workflow's own last save, and for a step head the
    // oldest version of its lineage. Healed here rather than at read time so the
    // value is durable — otherwise every boot would derive a different answer as
    // `updatedAt` moves.
    for (const wf of this.workflows.values()) {
      if (wf.createdAt !== undefined) continue;
      wf.createdAt = wf.updatedAt ?? Date.now();
      healed = true;
    }
    if (healed) this.persist();
    let healedSteps = false;
    for (const s of this.steps.values()) {
      if (s.createdAt !== undefined) continue;
      s.createdAt = this.lineageCreatedAt(s.id) ?? s.updatedAt ?? Date.now();
      healedSteps = true;
    }
    if (healedSteps) this.persistSteps();
    if (!this.workflows.has(DEFAULT_WORKFLOW.id)) {
      // A shallow copy, never the module-level const itself: `save()` restamps the
      // object it is handed in place, so seeding by reference would leak one
      // user's timestamps into every other UserContext in this process.
      // `updatedAt` stays undefined — a seed has to lose LWW to any remote row.
      this.workflows.set(DEFAULT_WORKFLOW.id, { ...DEFAULT_WORKFLOW, createdAt: Date.now() });
      this.persist();
    }
    // Every settle is forwarded, source included: a user-source turn is normally a
    // no-op here, but it must still be able to consume an explicit force-advance
    // (see onWorkflowTurnComplete).
    sessions.setTurnCompleteListener((sessionId, source, interrupted, failed) =>
      this.onWorkflowTurnComplete(sessionId, source, interrupted, failed),
    );
    // A rewind truncates the transcript out from under WorkflowState, which lives
    // on the meta and would otherwise still point at a step whose start marker is
    // gone (see rollbackToTranscript).
    sessions.setRewindListener((sessionId) => this.rollbackToTranscript(sessionId));
    // A step parked by a `result` that was not its conversation's last goes back
    // to running when the agent visibly carries on (see reopenParkedStep).
    sessions.setTurnResumedListener((sessionId) => this.reopenParkedStep(sessionId));
    // A running step's own routing rule overrides the global one for its turns.
    sessions.setStepRoutingProvider((sessionId) => this.stepRouting(sessionId));
  }

  /** The current step's routing rule and name, for SessionManager's router. */
  private stepRouting(sessionId: string): { rule?: RoutingRule; stepName?: string } | undefined {
    const meta = this.sessions.get(sessionId);
    const wf = meta?.workflow && this.resolveFor(meta.workflow);
    if (!meta?.workflow || !wf) return undefined;
    const step = wf.steps[meta.workflow.stepIndex];
    const content = step && this.stepContent(step);
    if (!content) return undefined;
    return { rule: content.routing, stepName: content.name };
  }

  /**
   * Roll a rewound session's workflow back to what its truncated transcript still
   * shows, and park it there. Called by SessionManager.rewindSession; returns true
   * when it settled the session itself.
   *
   * WorkflowState is on the SessionMeta, not in the transcript, so a rewind that
   * only truncated events would leave `stepIndex` pointing at a step whose
   * 'started' marker no longer exists — `findStepStart` would then return -1 and
   * every hand-off would be cut from the wrong slice. The surviving markers are
   * the authority: the newest one names the step the session is back inside.
   *
   * The step is parked at waiting-approval rather than re-run, which is what makes
   * the edit-and-resend flow work: a typed prompt iterates that same step
   * (iterateIfWaiting) and Approve advances, so the user changes their mind
   * mid-workflow without the engine racing them.
   *
   * Per-step spend (stepCostsUsd/stepTokens/stepDurationsMs) is deliberately kept,
   * exactly as a retry keeps it — the turns really ran. `lastStepOutput` is cleared
   * instead of recomputed: absent, the `{previous}` hand-off falls back to
   * lastAssistantText, which reads the truncated transcript and is right by
   * construction.
   */
  rollbackToTranscript(sessionId: string): boolean {
    const meta = this.sessions.get(sessionId);
    const wf = meta?.workflow;
    if (!meta || !wf?.started) return false;

    // A pending advance, an in-flight consolidation and a failure verdict all
    // belong to turns that no longer exist.
    wf.advanceOnComplete = undefined;
    wf.advanceOnCompleteStep = undefined;
    wf.advancing = false;
    wf.stepFailure = undefined;
    wf.lastStepOutput = undefined;

    let stepIndex: number | null = null;
    for (const event of this.store.loadTranscript(sessionId)) {
      if (event.kind !== 'workflow') continue;
      const data = event.data as WorkflowMarkerData;
      // 'retried' opens a step's turn the same way 'started' does; the other
      // markers only ever close one, so they say nothing about where we are.
      if (data.event === 'started' || data.event === 'retried') stepIndex = data.stepIndex;
    }

    // No surviving marker: the rewind went back past the very first step, i.e. to
    // the task description that kicks the workflow off. Put it back to the shape
    // attach() left it in, so the next prompt starts it again.
    if (stepIndex === null) {
      wf.started = false;
      wf.task = undefined;
      wf.stepIndex = 0;
      wf.stepStatuses = wf.stepStatuses.map(() => 'pending');
      wf.outputs = undefined;
      // diffBaselines is kept: it is a floor on the working tree, and the files on
      // disk did not roll back with the transcript.
      this.sessions.setStatus(sessionId, 'idle');
      return true;
    }

    wf.stepIndex = stepIndex;
    wf.stepStatuses = wf.stepStatuses.map((_, i) =>
      i < stepIndex! ? 'done' : i === stepIndex ? 'waiting-approval' : 'pending',
    );
    // Outputs published by a step that no longer counts as finished would still be
    // substituted into a later `{outputs.<name>}`, silently handing on work that
    // was rewound away.
    const def = this.resolveFor(wf);
    if (wf.outputs && def) {
      for (let i = stepIndex; i < def.steps.length; i++) {
        const name = this.stepContent(def.steps[i])?.outputName?.trim();
        if (name) delete wf.outputs[name];
      }
    }
    this.sessions.setStatus(sessionId, 'waiting-approval');
    this.marker(sessionId, {
      stepIndex,
      stepName: this.stepName(def?.steps[stepIndex]),
      event: 'waiting-approval',
    });
    return true;
  }

  /**
   * Put a parked step back to running because its conversation is visibly still
   * working. Called by SessionManager.handleWorkerEvent when the main agent emits
   * on a session with no turn on record: the `result` that parked the step was not
   * the conversation's last — a notification turn for a background task, an
   * interjection the CLI ran as a turn of its own — and another one is coming.
   * Returns true when it re-opened the step; the caller then marks the turn live.
   *
   * Running is what the stepper and the composer then show, and what makes
   * approve and iterate refuse until the turn ends. The real result settles the
   * step the ordinary way: its cost onto this step, then the park, the advance or
   * a queued iterate. No marker — findStepStart keys on `started`, and collectTurns
   * already folds the resumed turn into the step's output.
   *
   * A pre-run failure stays parked: its prompt never ran, so the activity is not
   * its turn, and re-parking it afterwards as a clean park would drop the failure
   * and its Retry, leaving a step that never ran looking ready to approve.
   */
  reopenParkedStep(sessionId: string): boolean {
    const state = this.sessions.get(sessionId)?.workflow;
    if (!state?.started || state.advancing) return false;
    const i = state.stepIndex;
    if (!this.resolveFor(state)?.steps[i]) return false;
    if (state.stepStatuses[i] !== 'waiting-approval') return false;
    if (state.stepFailure === 'pre-run') return false;
    state.stepStatuses[i] = 'running';
    // The verdict belonged to the result that turned out not to be the last.
    state.stepFailure = undefined;
    return true;
  }

  list(): WorkflowDef[] {
    return [...this.workflows.values()];
  }

  /**
   * Any session part-way through this workflow: started, with at least one step
   * still to run. A finished run keeps its state on the meta (every step 'done'),
   * and that is not in flight — nothing more will be resolved from the def.
   */
  private isRunning(workflowId: string): boolean {
    return this.sessions.list().some((s) => {
      const state = s.workflow;
      return (
        state?.workflowId === workflowId &&
        // An inline snapshot runs its own copy, untouched by a pull of this id.
        !state.def &&
        state.started &&
        state.stepStatuses.some((status) => status !== 'done')
      );
    });
  }

  /**
   * True when a pulled row is this user's own workflow wearing a stranger's
   * clothes: either it says so (`ownerId`), or the own map already holds that id.
   *
   * The second half is what makes the rule robust — a row pulled before storage
   * derived `ownerId` from its `user_id` column can carry a stale or absent
   * owner, and a second Clerk identity on the same machine publishes rows whose
   * `user_id` legitimately isn't the connected one. Own always beats shared.
   */
  private isOwnRow(w: { id: string; ownerId?: string }): boolean {
    return w.ownerId === this.userId || this.workflows.has(w.id);
  }

  /**
   * This user's view of other users' published workflows.
   *
   * Filtered at *read* time, not only when a pull lands: with storage
   * unreachable `setShared` is never called again, and a stale snapshot would
   * otherwise keep presenting an owned workflow as somebody else's for the whole
   * life of the process.
   */
  listShared(): WorkflowDef[] {
    return [...this.shared.values()].filter((w) => !this.isOwnRow(w));
  }

  /** Owned first, then shared — resolves a session's attached workflow either way. */
  private resolve(id: string): WorkflowDef | undefined {
    return this.workflows.get(id) ?? this.shared.get(id);
  }

  /**
   * The definition a session's run follows: its inline snapshot when it carries
   * one (a guest's own workflow, absent from this library), else the library row.
   */
  private resolveFor(state: WorkflowState): WorkflowDef | undefined {
    return state.def ?? this.resolve(state.workflowId);
  }

  /** True only for an id this user genuinely cannot write. */
  private isForeign(id: string): boolean {
    const shared = this.shared.get(id);
    return !!shared && !this.isOwnRow(shared);
  }

  /** Replace the shared set from a storage pull; returns true if it changed. */
  setShared(list: WorkflowDef[]): boolean {
    const approved = this.trust.approvals();
    const next = new Map(
      list
        .filter((w) => w.id && !this.isOwnRow(w))
        .map((w) => [w.id, this.markForeign('workflow', w, `workflow:${w.ownerId ?? ''}/${w.id}`, approved)] as const),
    );
    // Compared after filtering, so a delta made up only of dropped self-owned
    // rows doesn't rebroadcast an unchanged view.
    if (next.size === this.shared.size && [...next].every(([id, w]) => {
      const cur = this.shared.get(id);
      return cur && (cur.updatedAt ?? 0) === (w.updatedAt ?? 0);
    })) {
      return false;
    }
    this.shared = next;
    return true;
  }

  // ---- trust in synced content ----

  /**
   * Another user's workflow or step version, marked unless the owner already
   * reviewed this exact content here. Its signature, if any, is beside the
   * point: it is somebody else's prompt whoever's machine signed it, so it only
   * runs on this machine once someone has looked at it — and again whenever its
   * author changes it, a version row being immutable by convention only.
   */
  private markForeign<T extends WorkflowDef | StepDef>(
    kind: 'workflow' | 'step',
    item: T,
    key: string,
    approved: Record<string, string>,
  ): T {
    const digest = runnableDigest(kind, item);
    const clean = unmarked(item);
    return approved[key] === digest ? clean : { ...clean, untrusted: settledHold({ reason: 'foreign', digest }) };
  }

  /**
   * The mark a pulled own item keeps. The sync client marked everything this
   * machine did not sign; two things clear that here: content the owner already
   * reviewed under this key (an approval is bound to the digest, never to the
   * machine that signed it), and content identical to a trusted copy already
   * held — the same row coming round again, or a rename from another machine:
   * nothing that runs has changed. Anything else is re-settled against the
   * account's trusted machines, which decides whether another machine's
   * signature holds it back (`settledHold`) while keeping the record of it.
   */
  private settleMark<T extends WorkflowDef | StepDef>(item: T, key: string, sameAsTrusted: boolean, batch: TrustBatch): T {
    const mark = item.untrusted;
    if (!mark) return item;
    if (sameAsTrusted || batch.approvals()[key] === mark.digest) return unmarked(item);
    return { ...item, untrusted: settledHold(mark, batch.signers()) };
  }

  /** The approval record and trusted keys, each read at most once per batch and only if needed. */
  private trustBatch(): TrustBatch {
    let approved: Record<string, string> | undefined;
    let signers: ReadonlySet<string> | undefined;
    return {
      approvals: () => (approved ??= this.trust.approvals()),
      signers: () => (signers ??= this.trust.trustedSigners()),
    };
  }

  /**
   * Re-decide, after the account's trusted machines changed, whether each own
   * workflow and step another machine signed is held back. Trusting a key
   * releases what it signed; revoking one holds it back again — the mark kept
   * the record of who signed it all along. One persist and broadcast per kind.
   */
  resettleMarks(): void {
    const trusted = this.trust.trustedSigners();
    let workflowsChanged = false;
    let stepsChanged = false;
    for (const [id, wf] of this.workflows) {
      const next = resettled(wf, trusted);
      if (next === wf) continue;
      this.workflows.set(id, next);
      workflowsChanged = true;
    }
    for (const [id, s] of this.steps) {
      const next = resettled(s, trusted);
      if (next === s) continue;
      this.steps.set(id, next);
      stepsChanged = true;
    }
    for (const [key, s] of this.stepVersions) {
      if (s.ownerId !== this.userId) continue;
      const next = resettled(s, trusted);
      if (next === s) continue;
      this.stepVersions.set(key, next);
      stepsChanged = true;
    }
    if (workflowsChanged) {
      this.persist();
      this.broadcast({ type: 'workflows', workflows: this.list() });
    }
    if (stepsChanged) {
      this.persistSteps();
      this.broadcast({ type: 'steps', steps: this.listSteps() });
      this.broadcast({
        type: 'sharedSteps',
        sharedSteps: this.listSharedSteps(),
        pinnedSteps: this.listPinnedSteps(),
      });
    }
  }

  /**
   * Everything a run of `wf` would execute that is held back on this machine:
   * the workflow itself (its inline steps are its own content) and each pinned
   * version whose mark holds it back. Empty means it may run. A mark that only
   * records provenance (`held: false`, strict sync off) does not count.
   */
  untrustedParts(wf: WorkflowDef): UntrustedPart[] {
    const parts: UntrustedPart[] = [];
    if (isHeld(wf)) {
      parts.push({ kind: 'workflow', ownerId: wf.ownerId ?? this.userId, id: wf.id, name: wf.name, mark: wf.untrusted! });
    }
    for (const step of wf.steps) {
      if (!isStepRef(step)) continue;
      const pinned = this.stepVersions.get(stepKey(step.ownerId, step.stepId, step.version));
      if (!pinned || !isHeld(pinned)) continue;
      parts.push({
        kind: 'step',
        ownerId: pinned.ownerId,
        id: pinned.id,
        version: pinned.version,
        name: pinned.name,
        mark: pinned.untrusted!,
      });
    }
    return parts;
  }

  /**
   * Refuse, before anything is created, a workflow whose run would execute
   * unverified content. An unknown id passes: `attach` no-ops for it anyway.
   */
  assertRunnable(workflowId: string): void {
    const wf = this.resolve(workflowId);
    if (wf && this.untrustedParts(wf).length > 0) throw new UntrustedWorkflowError(wf.name);
  }

  /**
   * The owner reviewed this workflow and allows exactly that content to run
   * here. The digest is recorded and the mark cleared — for an own workflow the
   * next push then signs it as this machine's. Nothing else is released: not
   * the other items the same machine signed, nor a later change to this one.
   * `digest` must be the one the review showed — anything else means the
   * content moved underneath it.
   */
  trustWorkflow(ownerId: string, workflowId: string, digest: string): void {
    const own = this.workflows.get(workflowId);
    if (own) {
      const mark = own.untrusted;
      // Already runnable: a second click, or a second tab's review.
      if (!mark) return;
      if (mark.digest !== digest) throw new Error(`“${own.name}” changed after it was reviewed — review it again.`);
      this.trust.approve(`workflow:${this.userId}/${workflowId}`, digest);
      this.workflows.set(workflowId, unmarked(own));
      this.persist();
      this.broadcast({ type: 'workflows', workflows: this.list() });
      return;
    }
    const shared = this.shared.get(workflowId);
    if (!shared || (shared.ownerId ?? '') !== ownerId) throw new Error('That workflow is not available here.');
    const mark = shared.untrusted;
    if (!mark) return;
    if (mark.digest !== digest) throw new Error(`“${shared.name}” changed after it was reviewed — review it again.`);
    this.trust.approve(`workflow:${ownerId}/${workflowId}`, digest);
    this.shared.set(workflowId, unmarked(shared));
    this.broadcast({ type: 'sharedWorkflows', workflows: this.listShared() });
  }

  /**
   * As {@link trustWorkflow}, for one exact step version — own, or another
   * user's. The library head and the cached version can be separate objects
   * holding different content; only a copy whose mark carries the reviewed
   * digest is cleared, so approving one never releases the other unseen.
   */
  trustStep(ownerId: string, stepId: string, version: number, digest: string): void {
    const own = ownerId === this.userId;
    const key = stepKey(ownerId, stepId, version);
    const cached = this.stepVersions.get(key);
    const headNow = own ? this.steps.get(stepId) : this.sharedSteps.get(`${ownerId}/${stepId}`);
    const head = headNow?.version === version ? headNow : undefined;
    const copies = [cached, head].filter((c): c is StepDef => !!c);
    if (copies.length === 0) throw new Error('That step version is not available here.');
    const marked = copies.filter((c) => c.untrusted);
    if (marked.length === 0) return;
    const reviewed = marked.filter((c) => c.untrusted!.digest === digest);
    if (reviewed.length === 0) {
      throw new Error(`“${marked[0].name}” changed after it was reviewed — review it again.`);
    }
    this.trust.approve(`step:${ownerId}/${stepId}/${version}`, digest);
    if (cached && reviewed.includes(cached)) this.stepVersions.set(key, unmarked(cached));
    if (head && reviewed.includes(head)) {
      if (own) this.steps.set(stepId, unmarked(head));
      else this.sharedSteps.set(`${ownerId}/${stepId}`, unmarked(head));
    }
    if (own) {
      this.persistSteps();
      this.broadcast({ type: 'steps', steps: this.listSteps() });
    }
    this.broadcast({
      type: 'sharedSteps',
      sharedSteps: this.listSharedSteps(),
      pinnedSteps: this.listPinnedSteps(),
    });
  }

  // ---- steps (versioned, shareable) ----

  listSteps(): StepDef[] {
    return [...this.steps.values()];
  }

  listSharedSteps(): StepDef[] {
    return [...this.sharedSteps.values()];
  }

  /** Every immutable version this user owns — the durable history (not just heads). */
  listOwnStepVersions(): StepDef[] {
    return [...this.stepVersions.values()].filter((s) => s.ownerId === this.userId);
  }

  /** Every pin referenced by this user's own workflows, resolved to its immutable version. */
  listPinnedSteps(): StepDef[] {
    const out: StepDef[] = [];
    for (const ref of this.refs()) {
      const s = this.stepVersions.get(stepKey(ref.ownerId, ref.stepId, ref.version));
      if (s) out.push(s);
    }
    return out;
  }

  /** Distinct step refs across all owned workflows. */
  private refs(): StepRef[] {
    const seen = new Map<string, StepRef>();
    for (const wf of this.workflows.values()) {
      for (const step of wf.steps) {
        if (isStepRef(step)) seen.set(stepKey(step.ownerId, step.stepId, step.version), step);
      }
    }
    return [...seen.values()];
  }

  /** Refs whose pinned version isn't cached yet — userContext resolves these from storage. */
  unresolvedRefs(): StepRef[] {
    return this.refs().filter((r) => !this.stepVersions.has(stepKey(r.ownerId, r.stepId, r.version)));
  }

  /**
   * When the step *id* behind these cached versions was first created, as far as
   * this bridge can tell: the earliest `createdAt` any version carries, else the
   * oldest version's own mint time. Covers a head that `deleteStep` removed while
   * its versions stayed cached, which is why it reads the version map and not
   * `this.steps`.
   */
  private lineageCreatedAt(id: string): number | undefined {
    let out: number | undefined;
    for (const s of this.stepVersions.values()) {
      if (s.ownerId !== this.userId || s.id !== id) continue;
      out = earliest(out, s.createdAt ?? s.updatedAt);
    }
    return out;
  }

  /**
   * Adopt resolved immutable versions (own history from a pull, or foreign pins).
   *
   * A known `createdAt` is kept: `POST /steps/resolve` answers from the raw blob
   * with no column injection, so a pin resolved through it can arrive without the
   * field and must not wipe what is already cached.
   *
   * `requested` names what was asked for, and anything else in the answer is
   * dropped: a version is filed under the owner it names, so a blob in another
   * user's history claiming to be this user's would join this user's own history
   * — and be pushed back to storage as theirs.
   *
   * Every version is checked on the way in: an own one settles the mark the sync
   * client gave it, another user's is marked until reviewed. A version this
   * machine already trusts is never displaced by an unverified copy claiming the
   * same number with different content — the number is what a workflow pins.
   */
  addStepVersions(list: StepDef[], requested?: readonly { ownerId: string; id: string }[]): void {
    const batch = this.trustBatch();
    for (const raw of list) {
      if (requested && !requested.some((r) => r.ownerId === raw.ownerId && r.id === raw.id)) continue;
      const key = stepKey(raw.ownerId, raw.id, raw.version);
      const approvalKey = `step:${raw.ownerId}/${raw.id}/${raw.version}`;
      const cached = this.stepVersions.get(key);
      const s =
        raw.ownerId === this.userId
          ? this.settleMark(raw, approvalKey, !!cached && vouchedFor(cached) && sameContent(cached, raw), batch)
          : this.markForeign('step', raw, approvalKey, batch.approvals());
      if (!vouchedFor(s) && cached && vouchedFor(cached) && !sameContent(cached, s)) {
        console.warn(`[step ${s.id}] unverified v${s.version} differs from the trusted copy — kept ours`);
        continue;
      }
      const createdAt = earliest(cached?.createdAt, s.createdAt);
      this.stepVersions.set(key, createdAt === undefined ? s : { ...s, createdAt });
    }
  }

  /** Cached versions of one step, newest first (best-effort local view). */
  listStepVersions(ownerId: string, stepId: string): StepDef[] {
    return [...this.stepVersions.values()]
      .filter((s) => s.ownerId === ownerId && s.id === stepId)
      .sort((a, b) => b.version - a.version);
  }

  /**
   * Replace the shared-step library; returns true if it changed.
   *
   * A row claiming this user as its owner is dropped rather than adopted: the
   * foreign library is by definition other people's, and letting such a row
   * through also put it in `stepVersions`, from where `listOwnStepVersions` fed
   * it to `sync.pushSteps` — i.e. this bridge re-published somebody else's step
   * as ours (easy to hit when both sides are stamped the literal `local`).
   */
  setSharedSteps(list: StepDef[]): boolean {
    const approved = this.trust.approvals();
    const next = new Map(
      list
        .filter((s) => s.id && s.ownerId && s.ownerId !== this.userId)
        .map((s) => [`${s.ownerId}/${s.id}`, this.markForeign('step', s, `step:${s.ownerId}/${s.id}/${s.version}`, approved)] as const),
    );
    const changed =
      next.size !== this.sharedSteps.size ||
      [...next].some(([k, s]) => (this.sharedSteps.get(k)?.version ?? -1) !== s.version);
    this.sharedSteps = next;
    // Library heads are resolvable versions too — except that a version the
    // owner reviewed keeps the content they reviewed: an author rewriting a
    // published version in place is shown as a new, unreviewed head in the
    // library, but cannot change what a workflow pinned to it runs.
    for (const s of next.values()) {
      const key = stepKey(s.ownerId, s.id, s.version);
      const cached = this.stepVersions.get(key);
      if (s.untrusted && cached && !cached.untrusted && !sameContent(cached, s)) continue;
      this.stepVersions.set(key, s);
    }
    return changed;
  }

  /** Adopt own steps pulled from storage (LWW on version). */
  applySyncedSteps(list: StepDef[]): void {
    let changed = false;
    const batch = this.trustBatch();
    for (const pulled of list) {
      // This user's own table only ever holds their own steps; a row naming
      // another owner would be filed under that owner's version key while
      // sitting in this library as one of theirs. Another account's row — one
      // machine key signs for all of them — so it is refused outright.
      if (pulled.ownerId !== this.userId) {
        console.warn(`[step ${pulled.id}] pulled from this user's table but owned by ${pulled.ownerId} — ignored`);
        continue;
      }
      const cur = this.steps.get(pulled.id);
      if (!cur || pulled.version >= cur.version) {
        // Trust before anything is stored (see settleMark). The trusted copy to
        // compare with is this exact version, as the head or in the history.
        const twin = [cur, this.stepVersions.get(stepKey(pulled.ownerId, pulled.id, pulled.version))].some(
          (t) => !!t && vouchedFor(t) && t.version === pulled.version && sameContent(t, pulled),
        );
        const s = this.settleMark(pulled, `step:${pulled.ownerId}/${pulled.id}/${pulled.version}`, twin, batch);
        // Content is last-write-wins, but creation time only ever moves earlier —
        // a peer (or an older bridge) pushing a blob without it must not erase it.
        const createdAt = earliest(cur?.createdAt, s.createdAt, this.lineageCreatedAt(s.id));
        const merged = createdAt === undefined ? s : { ...s, createdAt };
        this.steps.set(s.id, merged);
        const versionKey = stepKey(merged.ownerId, merged.id, merged.version);
        const pinned = this.stepVersions.get(versionKey);
        // A version row is immutable by contract — that is the whole basis on
        // which a workflow pins one. A pulled row claiming an existing version
        // with *different* content is either a bug or an edit to a body a
        // running workflow already resolved, so the head moves and the pin does
        // not. The head is what the next save builds on, so nothing is stuck.
        if (!pinned || sameContent(pinned, merged)) this.stepVersions.set(versionKey, merged);
        else console.warn(`[step ${merged.id}] pulled v${merged.version} differs from the pinned copy — kept ours`);
        changed = true;
      }
    }
    if (changed) this.persistSteps();
  }

  /**
   * Save or update a step. A content change bumps the (immutable) version;
   * toggling `published` alone keeps the version and just re-flags the head.
   */
  saveStep(content: StepContent, stepId: string | undefined, published: boolean, ownerName: string | undefined): StepDef {
    const id = stepId && this.steps.has(stepId) ? stepId : stepId || randomUUID();
    const head = this.steps.get(id);
    const contentChanged = !head || !sameContent(head, content);
    const version = head ? (contentChanged ? head.version + 1 : head.version) : 1;
    const step: StepDef = {
      ...content,
      id,
      ownerId: this.userId,
      ownerName,
      version,
      published,
      updatedAt: Date.now(),
      // Carried forward across version bumps: this is the step id's birthday, not
      // this version's mint time (that is `updatedAt` on this immutable row).
      createdAt: head?.createdAt ?? this.lineageCreatedAt(id) ?? Date.now(),
    };
    // The content above was spread from the client, so its `untrusted` (if any)
    // is the client's: the head's own verdict wins, and a client's only ever adds
    // one — a copy of held-back content (see markAfterSave).
    const mark = markAfterSave('step', step, head?.untrusted, step.untrusted);
    if (mark) step.untrusted = mark;
    else delete step.untrusted;
    this.steps.set(id, step);
    this.stepVersions.set(stepKey(step.ownerId, id, version), step);
    this.persistSteps();
    this.broadcast({ type: 'steps', steps: this.listSteps() });
    return step;
  }

  /** Drop a step from this user's library; immutable versions stay cached for existing pins. */
  deleteStep(stepId: string): void {
    if (!this.steps.delete(stepId)) return;
    this.persistSteps();
    this.broadcast({ type: 'steps', steps: this.listSteps() });
  }

  private persistSteps() {
    this.store.saveSteps(this.listSteps());
    // Heads alone would lose intermediate versions across a restart; persist the full history too.
    this.store.saveStepVersions(this.listOwnStepVersions());
  }

  /** Resolve a workflow step to its runnable content (refs → pinned immutable version). */
  private stepContent(step: WorkflowDef['steps'][number]): StepContent | undefined {
    if (!isStepRef(step)) return step;
    return this.stepVersions.get(stepKey(step.ownerId, step.stepId, step.version));
  }

  /**
   * Point a ref back at this user when its `ownerId` drifted — the browser used
   * to stamp new refs with its Clerk id while the bridge stamps steps with
   * `ctx.userId` (the literal `local` with auth off, `''` with Clerk disabled in
   * the web build), so the two disagree and the ref resolves nowhere.
   *
   * Deliberately narrow: only for a step this user owns *and* only when the exact
   * pinned version is already in their own history. It can never invent a version
   * or repoint a genuinely foreign pin. Returns true if anything changed.
   */
  private normalizeRefs(workflow: WorkflowDef): boolean {
    let changed = false;
    for (const step of workflow.steps) {
      if (!isStepRef(step)) continue;
      if (step.ownerId === this.userId) continue;
      if (!this.steps.has(step.stepId)) continue;
      if (!this.stepVersions.has(stepKey(this.userId, step.stepId, step.version))) continue;
      step.ownerId = this.userId;
      changed = true;
    }
    return changed;
  }

  save(workflow: WorkflowDef): WorkflowDef {
    // A shared (foreign) workflow is read-only: saving its id would fork it under
    // this user silently. Duplicating instead arrives with a fresh (empty) id.
    // Thrown rather than returned unchanged — the caller has to be able to tell a
    // refused write from a successful one.
    if (workflow.id && this.isForeign(workflow.id)) {
      throw new ForeignWorkflowError(workflow.id);
    }
    // The verdict is this bridge's, never the caller's: an existing workflow keeps
    // its own whatever the client sent, and a client's mark only ever adds one —
    // a copy of held-back content, or a pinned step it held back made inline
    // (see markAfterSave). Read before the id is minted below.
    const existingMark = workflow.id ? this.workflows.get(workflow.id)?.untrusted : undefined;
    const requestedMark = workflow.untrusted;
    if (!workflow.id) {
      workflow.id = randomUUID();
      // A fresh id is always born now, whatever the caller sent: both `duplicate()`
      // in the editor and `create_workflow` build the new workflow by spreading an
      // existing one, and the copy must not inherit the original's birthday.
      workflow.createdAt = Date.now();
    } else {
      // Re-read from the stored row, so an older client, an MCP `{ ...target }`
      // spread or a peer blob that dropped the field cannot lose the creation time.
      workflow.createdAt =
        earliest(this.workflows.get(workflow.id)?.createdAt, workflow.createdAt) ?? Date.now();
    }
    this.normalizeRefs(workflow);
    workflow.updatedAt = Date.now(); // LWW key for cross-instance sync
    workflow.ownerId = this.userId; // authoritative — never trust a client-sent owner
    const mark = markAfterSave('workflow', workflow, existingMark, requestedMark);
    if (mark) workflow.untrusted = mark;
    else delete workflow.untrusted;
    this.workflows.set(workflow.id, workflow);
    this.persist();
    this.broadcast({ type: 'workflows', workflows: this.list() });
    return workflow;
  }

  /**
   * Adopt a batch of workflows pulled from the storage server — LWW on
   * updatedAt, no restamp. One persist and one broadcast for the whole batch:
   * a per-workflow broadcast made a sync fan a shared re-pull out to every
   * other live user context once per adopted row.
   */
  applySyncedAll(list: WorkflowDef[]) {
    let changed = false;
    const batch = this.trustBatch();
    for (const pulled of list) {
      const cur = this.workflows.get(pulled.id);
      if (cur && (pulled.updatedAt ?? 0) <= (cur.updatedAt ?? 0)) continue;
      // Kept rather than dropped when it is still unverified: it is shown, and
      // held back from running until reviewed (see settleMark, untrustedParts).
      // A row in this user's own table naming another owner is another account's
      // workflow, whatever signed it — one machine key signs for every account on
      // that machine — so it is held back as someone else's would be.
      // Compared by digest rather than `sameSteps`: storage hands rows back with
      // their keys reordered (jsonb), which a plain JSON comparison reads as a
      // change to every step.
      const twin = !!cur && vouchedFor(cur) && runnableDigest('workflow', cur) === runnableDigest('workflow', pulled);
      const workflow =
        pulled.ownerId !== undefined && pulled.ownerId !== this.userId
          ? { ...unmarked(pulled), untrusted: settledHold({ reason: 'foreign', digest: runnableDigest('workflow', pulled) }) }
          : this.settleMark(pulled, `workflow:${this.userId}/${pulled.id}`, twin, batch);
      // A workflow a session is part-way through resolves its steps live, so
      // adopting a pulled body here rewrites the instructions of a run already
      // under way — including the step the user is about to approve. Whoever can
      // write that storage row would be editing work in flight, invisibly.
      // Keep ours until the run ends; the row is still newer, so the next pull
      // after it settles adopts it the normal way.
      if (cur && this.isRunning(workflow.id) && !sameSteps(cur, workflow)) {
        console.warn(
          `[workflow ${workflow.id}] pulled step changes held back: a session is mid-run`,
        );
        continue;
      }
      // The content is adopted wholesale (LWW), but creation time only ever moves
      // earlier — a newer remote row missing `createdAt` must not erase ours.
      this.workflows.set(
        workflow.id,
        cur ? { ...workflow, createdAt: earliest(cur.createdAt, workflow.createdAt) } : workflow,
      );
      changed = true;
    }
    if (!changed) return;
    this.persist();
    this.broadcast({ type: 'workflows', workflows: this.list() });
  }

  delete(workflowId: string) {
    this.workflows.delete(workflowId);
    this.persist();
    this.broadcast({ type: 'workflows', workflows: this.list() });
  }

  private persist() {
    this.store.saveWorkflows(this.list());
  }

  /**
   * Attach a workflow to a session; it starts on the user's first prompt (the
   * task description).
   *
   * Throws for a workflow with unverified content, before anything is seeded:
   * attaching already copies step 0's model and permission mode onto the session.
   * Callers that create the session first should `assertRunnable` before that.
   */
  attach(sessionId: string, workflowId: string, stepOverrides?: unknown) {
    const wf = this.resolve(workflowId);
    if (!wf) return;
    if (this.untrustedParts(wf).length > 0) throw new UntrustedWorkflowError(wf.name);
    this.attachDef(sessionId, wf, undefined, stepOverrides);
  }

  /**
   * Attach a self-contained workflow that is not in this library — a guest's own,
   * every step already inline. The snapshot rides `meta.workflow.def`, so it
   * persists with the session and survives a bridge restart.
   */
  attachInline(sessionId: string, def: WorkflowDef, stepOverrides?: unknown) {
    this.attachDef(sessionId, def, def, stepOverrides);
  }

  private attachDef(
    sessionId: string,
    wf: WorkflowDef,
    inline: WorkflowDef | undefined,
    stepOverrides?: unknown,
  ) {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    const overrides = sanitizeStepOverrides(stepOverrides, wf.steps.length);
    meta.workflow = {
      workflowId: wf.id,
      ...(inline ? { def: inline } : {}),
      stepIndex: 0,
      stepStatuses: wf.steps.map(() => 'pending'),
      started: false,
      ...(overrides.some(Boolean) ? { stepOverrides: overrides } : {}),
    } satisfies WorkflowState;
    this.seedStep0(meta, wf);
    this.sessions.setStatus(sessionId, meta.status); // persist + broadcast the attached workflow
  }

  /**
   * Reflect step 0's mode/model on the session up front so the composer pill is
   * correct before the first prompt. runStep re-applies these (via the worker) on start.
   */
  private seedStep0(meta: SessionMeta, wf: WorkflowDef) {
    const step0 = wf.steps[0] && this.stepContent(wf.steps[0]);
    if (!step0 || !meta.workflow) return;
    // Seeding copies step 0's permission mode onto the session, so content held
    // back here must not get to choose it — through a per-run override edit on a
    // synced session carrying its own workflow, say (attach refuses before this).
    if (this.untrustedParts(wf).length > 0 || (meta.workflow.def && wf.untrusted)) return;
    const effective = this.effectiveContent(meta.workflow, 0, step0);
    meta.permissionMode = step0.permissionMode;
    meta.model = effective.model;
    meta.reasoningEffort = effective.reasoningEffort;
    meta.workflow.stepPermissionMode = step0.permissionMode;
  }

  /**
   * The model and effort step `i` actually runs on: its stored content with this
   * run's override (if any) laid over it. An override's effort is absolute —
   * `null` is Auto even when the step sets one; an absent field falls through.
   */
  private effectiveContent(
    state: WorkflowState,
    i: number,
    content: StepContent,
  ): { model: string; reasoningEffort: StepContent['reasoningEffort'] } {
    const override: WorkflowStepOverride | null | undefined = state.stepOverrides?.[i];
    const model = resolveModelId(override?.model ?? content.model);
    const reasoningEffort =
      override && override.reasoningEffort !== undefined
        ? (override.reasoningEffort ?? undefined)
        : content.reasoningEffort;
    return { model, reasoningEffort };
  }

  /**
   * Replace this run's per-step overrides. Only still-pending steps take the new
   * value — a running or finished step keeps whatever it ran on, so a late edit
   * racing an advance either lands before the step starts or is ignored. Before
   * the workflow starts, step 0's seed on the session is refreshed too.
   */
  setStepOverrides(sessionId: string, stepOverrides: unknown) {
    const meta = this.sessions.get(sessionId);
    const state = meta?.workflow;
    const wf = state && this.resolveFor(state);
    if (!meta || !state || !wf) return;
    const incoming = sanitizeStepOverrides(stepOverrides, wf.steps.length);
    const next = wf.steps.map((_, i) =>
      state.stepStatuses[i] === 'pending' ? (incoming[i] ?? null) : (state.stepOverrides?.[i] ?? null),
    );
    state.stepOverrides = next.some(Boolean) ? next : undefined;
    if (!state.started) this.seedStep0(meta, wf);
    this.sessions.setStatus(sessionId, meta.status); // persist + broadcast
  }

  /**
   * Returns true if this prompt was consumed as the workflow's task description
   * (i.e. it kicked off step 0); false means the caller should treat it as normal chat.
   */
  startIfPending(
    sessionId: string,
    userText: string,
    attachments?: PromptAttachment[],
    /** Who kicked the workflow off; the first step's turn is theirs. */
    actor?: Actor,
  ): boolean {
    const meta = this.sessions.get(sessionId);
    if (!meta?.workflow || meta.workflow.started) return false;
    meta.workflow.started = true;
    meta.workflow.task = userText;
    this.sessions.maybeAutoName(sessionId, userText);
    // Snapshot the working tree now so later steps' {diff} excludes pre-existing
    // dirty state. Fire-and-forget: the first fresh step is at least one approval
    // gap away, long after this resolves.
    void this.captureDiffBaseline(sessionId);
    this.runStepSafely(sessionId, undefined, true, attachments, actor);
    return true;
  }

  /** Every root a session may work in — its project's, else just its cwd. */
  private rootsFor(cwd: string): string[] {
    return rootsForCwd(this.store.loadProjects(), cwd);
  }

  private async captureDiffBaseline(sessionId: string) {
    const meta = this.sessions.get(sessionId);
    if (!meta?.workflow) return;
    meta.workflow.diffBaselines = await captureBaselines(this.rootsFor(meta.cwd));
  }

  /**
   * Baselines a step's `{diff}`/`{changed}` are taken against, and where they came
   * from. One resolver, shared with the review UI: the workflow's own snapshot wins
   * (it is what "since this run started" means), then the session's, then a
   * synthesized HEAD flagged `synthetic`. The fallback is the point — resolving to
   * `[]` used to render as nothing at all, which reads to a step exactly like a
   * clean tree.
   */
  private baselinesFor(
    meta: SessionMeta,
  ): Promise<{ baselines: RepoBaseline[]; source: 'session' | 'workflow' | 'synthetic' }> {
    return this.sessions.baselinesFor(meta, 'workflow');
  }

  /** The `{changed}` block: every file this run touched, per commit unit. */
  private async renderChanges(resolved: {
    baselines: RepoBaseline[];
    source: 'session' | 'workflow' | 'synthetic';
  }): Promise<string> {
    const repos: ChangedRepo[] = [];
    for (const baseline of resolved.baselines) {
      const { files, stale, untrackedOmitted } = await changedFiles(baseline.repo, baseline);
      repos.push({
        repo: baseline.repo,
        branch: await repoBranch(baseline.repo),
        baseline: stale ? 'stale' : resolved.source,
        files,
        untrackedOmitted,
      });
    }
    return renderChanged(repos);
  }

  /** The `{roots}` block for this session: commit units, their branches, orphan roots. */
  private async renderWorkspace(meta: SessionMeta): Promise<string> {
    const { repos, orphans } = await groupByRepo(this.rootsFor(meta.cwd));
    const branches = new Map<string, string | null>();
    for (const repo of repos) branches.set(repo.root, await repoBranch(repo.root));
    return renderRoots(repos, orphans, branches, meta.cwd);
  }

  private marker(sessionId: string, data: WorkflowMarkerData) {
    this.sessions.emitEvent(sessionId, 'workflow', data);
  }

  /**
   * @param entry True when first entering the step (start/advance/approve) — the
   *   point where a fresh-start step resets its session and gets the hand-off.
   *   False on retry/iterate, which stay in the step's existing (fresh or
   *   inherited) conversation so feedback lands on the same context.
   */
  private async runStep(
    sessionId: string,
    feedback?: string,
    entry = false,
    /** Attachments the user sent with the task description — entry step only. */
    attachments?: PromptAttachment[],
    /**
     * Who caused this step to run, when a person did. Absent for the engine's own
     * advances, which belong to nobody — the sidebar then shows no avatar rather
     * than crediting whoever happened to start the workflow hours earlier.
     */
    actor?: Actor,
  ) {
    const meta = this.sessions.get(sessionId);
    const wf = meta?.workflow && this.resolveFor(meta.workflow);
    if (!meta || !meta.workflow || !wf) {
      // `advance` clears `advancing` without its own broadcast, riding whatever this
      // call broadcasts next — so a return that broadcasts nothing leaves the client's
      // loader spinning forever on a stale flag.
      this.sessions.persistMeta(sessionId);
      return;
    }
    const i = meta.workflow.stepIndex;
    const step = wf.steps[i];
    const content = step && this.stepContent(step);
    if (!step || !content) {
      // Unresolved reference (e.g. a shared step version this bridge couldn't fetch).
      if (step) {
        // Park it so Approve can still skip past, and fail the turn so the transcript
        // ends on a failure row carrying the reason — with a Retry that re-renders
        // this step once the version resolves. State set before failTurn, whose
        // setStatus is what broadcasts.
        meta.workflow.stepStatuses[i] = 'waiting-approval';
        meta.workflow.stepFailure = 'pre-run';
        this.sessions.failTurn(
          sessionId,
          `Step ${i + 1} could not be resolved — the shared step version it pins is not available on this bridge.`,
        );
      } else {
        // Index past the last step (a workflow edited shorter mid-run, say): nothing
        // to run, but the bumped stepIndex and the cleared `advancing` still have to
        // reach the client.
        this.sessions.persistMeta(sessionId);
      }
      return;
    }

    // The authoritative gate. `attach` refuses an unverified workflow up front, but
    // every way into a step — advance, retry, start — arrives here, and a pull can
    // mark content mid-run (a pinned version rewritten underneath it). Parked like
    // an unresolved pin, so Approve can still skip past and Retry re-renders once
    // the owner has reviewed it.
    const refusal = this.unverifiedRefusal(meta.workflow, wf, step);
    if (refusal) {
      meta.workflow.stepStatuses[i] = 'waiting-approval';
      meta.workflow.stepFailure = 'pre-run';
      this.sessions.failTurn(sessionId, `Step ${i + 1} was not run: ${refusal}`);
      return;
    }

    // A step may run on any provider, but it cannot *carry* a conversation across
    // one: nothing links a claudeSessionId to a codexThreadId, so the new model
    // would inherit a transcript it cannot read. A crossing step therefore has to
    // be a fresh start.
    //
    // Checked here rather than at setModel below because a step is the *stored*
    // model's caller: a refusal there would leave the step running on whatever the
    // session happened to be on, which is worse than not starting it. The editor
    // forces freshStart on a crossing step, so reaching this is an older workflow
    // or a hand-edited one — parked as a pre-run failure, the existing mechanism,
    // so Approve can still skip past it.
    const effective = this.effectiveContent(meta.workflow, i, content);
    const stepProvider = providerForModel(effective.model);
    // Keyed on the conversation the session actually holds, not on `meta.model`:
    // attaching a workflow writes step 0's model onto the session up front, so by
    // the time the step runs `meta.model` already agrees with it and would report
    // no crossing at all. The resume pointers are the thing that cannot move.
    const strandedConversation =
      stepProvider === 'openai' ? meta.claudeSessionId : meta.codexThreadId;
    const crossesProvider =
      Boolean(strandedConversation) &&
      providerSwitchNeedsFreshStart(
        stepProvider === 'openai' ? 'anthropic' : 'openai',
        stepProvider,
      );
    // One crossing is not an authoring mistake: the user switched this session's
    // provider by hand (SessionManager.switchProvider), so the conversation this
    // step would inherit is one the switch already replaced — there is nothing
    // left to protect. Start fresh for this entry instead of parking, which is
    // what keeps the run moving; the user was told this would happen before they
    // confirmed the switch. One-shot, and consumed whether or not it was needed.
    const switched = meta.workflow.providerSwitched === true;
    meta.workflow.providerSwitched = undefined;
    const freshStart = content.freshStart || (crossesProvider && switched);
    if (crossesProvider && !freshStart) {
      meta.workflow.stepStatuses[i] = 'waiting-approval';
      meta.workflow.stepFailure = 'pre-run';
      this.sessions.failTurn(
        sessionId,
        `Step ${i + 1} runs on ${effective.model}, a different provider from the step before it, ` +
          'but is set to continue that step’s conversation. A conversation cannot move between ' +
          'providers — turn on “Fresh start” for this step, then Retry.',
      );
      return;
    }
    // Drop the old provider's conversation *before* setModel, which refuses a
    // cross-provider switch on a session that still has one. The hand-off text
    // below is read from the transcript and the step's stored output, so it
    // survives this.
    if (crossesProvider) this.sessions.resetClaudeSession(sessionId);

    meta.workflow.stepStatuses[i] = 'running';
    meta.workflow.stepPermissionMode = content.permissionMode;
    meta.workflow.stepFailure = undefined; // the step is running again; judge this attempt on its own
    // A manual model/effort change paused routing for the step it was made in;
    // a new step starts routed again.
    if (entry) meta.routingPaused = undefined;
    // Clear any stale waiting-approval status before the async model/mode setup below.
    this.sessions.setStatus(sessionId, 'running');
    this.marker(sessionId, {
      stepIndex: i,
      stepName: content.name,
      event: feedback !== undefined ? 'retried' : 'started',
      feedback,
    });

    // Per-step model + permission mode take effect before the prompt is queued.
    // Both carry this run's override for the step, if any (see effectiveContent).
    await this.sessions.setModel(sessionId, effective.model);
    // Called even when the step sets none, which is what *clears* it: skipping the
    // call would leak a high-effort step's setting into every later step of the run.
    await this.sessions.setReasoningEffort(sessionId, effective.reasoningEffort ?? null);
    await this.sessions.setPermissionMode(sessionId, content.permissionMode);

    const feedbackText = feedback
      ? `\n\nThe user reviewed the previous attempt at this step and asked for changes: ${feedback}`
      : '';
    // Hand-off tokens are looked for in the *template*: after substitution they are
    // gone, and substituted output text can itself contain a literal {previous}.
    // A template pulling {outputs.*} already carries its context, so the
    // auto-prepend below must not inject the same text a second time.
    const usesTokens = usesHandoffTokens(content.promptTemplate);

    // Fresh start: drop the accumulated conversation and seed a clean session
    // with a compact hand-off — the previous step's final output ({previous},
    // e.g. a plan) and the working-tree diff ({diff}). Only when entering a step
    // that actually has predecessors (i > 0); step 0 has no prior output and its
    // "diff" would just be the repo's pre-existing dirty state. Retries stay in
    // the fresh session already established for this step.
    const handoff = freshStart && entry && i > 0;
    const previous = handoff
      ? (meta.workflow.lastStepOutput ?? this.sessions.lastAssistantText(sessionId))
      : '';
    // Unlike {previous}, {diff} and {changed} are resolved off their own template
    // check, not just `handoff` — an inheriting step (freshStart: false, e.g. a
    // Commit Agent that wants {changed} without dragging in the whole prior
    // conversation) can ask for either directly. `handoff` still forces {diff}
    // resolution for the auto-prepend below, and a retry (`entry` false) recomputes
    // it, which is what a retried commit step wants.
    const usesDiffToken = USES_DIFF_RE.test(content.promptTemplate);
    const usesChangedToken = USES_CHANGED_RE.test(content.promptTemplate);
    const baselines =
      handoff || usesDiffToken || usesChangedToken ? await this.baselinesFor(meta) : null;
    const diffRaw = handoff || usesDiffToken ? await multiRepoDiff(baselines!.baselines) : '';
    // A template that asked for {diff} reads an explicit sentence rather than a
    // silent '' — substituteTokens only parks a step for missing {outputs.*}, so an
    // empty diff has to say so itself to avoid looking like a resolution failure.
    const diff = handoff || usesDiffToken ? diffRaw || NO_DIFF : '';
    const changed = usesChangedToken ? await this.renderChanges(baselines!) : '';
    // Unlike {diff}, {roots} is workspace shape rather than a hand-off, so it is
    // not gated on `handoff` and works in an inheriting step too. Resolved only
    // when the template asks for it — it costs a --show-toplevel plus an
    // --abbrev-ref per root, on the step-entry path the user waits through.
    const roots = USES_ROOTS_RE.test(content.promptTemplate) ? await this.renderWorkspace(meta) : '';

    // Every token is filled in one pass over the *template*, so text pulled in by
    // one token can never be rescanned for another (see substituteTokens). An
    // unresolved {outputs.<name>} parks the step instead of running it blind.
    const base = content.promptTemplate.includes('{feedback}')
      ? content.promptTemplate
      : content.promptTemplate + '{feedback}';
    const resolved = substituteTokens(
      base,
      { task: meta.workflow.task ?? '', feedback: feedbackText, previous, diff, changed, roots },
      meta.workflow.outputs ?? {},
    );
    let prompt = resolved.prompt;
    if (resolved.missing.length) {
      meta.workflow.stepStatuses[i] = 'waiting-approval';
      meta.workflow.stepFailure = 'pre-run';
      // Failure row first (it carries the message and the Retry); the marker after it
      // names the missing outputs on the step divider.
      this.sessions.failTurn(
        sessionId,
        `Step "${content.name}" was not run: nothing published for ${resolved.missing
          .map((n) => `{outputs.${n}}`)
          .join(', ')}.`,
      );
      this.marker(sessionId, {
        stepIndex: i,
        stepName: content.name,
        event: 'waiting-approval',
        missingOutputs: resolved.missing,
      });
      return;
    }

    if (handoff) {
      // A template pulling {outputs.*} (or the hand-off tokens directly) already
      // carries its context — auto-prepending would inject the same text twice.
      if (!usesTokens) {
        const parts: string[] = [];
        if (previous) parts.push(`## Context from the previous step\n\n${previous}`);
        if (diffRaw) parts.push(`## Changes so far (git diff)\n\n\`\`\`diff\n${diffRaw}\n\`\`\``);
        if (parts.length) prompt = `${parts.join('\n\n')}\n\n---\n\n${prompt}`;
      }
      this.sessions.resetClaudeSession(sessionId);
    } else if (freshStart && entry) {
      // Nothing to hand off (a fresh first step) — still start from a clean session.
      this.sessions.resetClaudeSession(sessionId);
    }

    if (feedback !== undefined) this.sessions.markRetry(sessionId);
    this.sessions.prompt(sessionId, prompt, 'workflow', attachments, [], actor);
  }

  /**
   * Every caller fire-and-forgets runStep, so a throw past its own handling would be
   * an unhandled rejection leaving the step wedged at 'running' with nothing in
   * flight. Park it as a pre-run failure instead: the transcript gets a failure row
   * with a Retry, and the stepper's Approve can still skip past.
   */
  private runStepSafely(
    sessionId: string,
    feedback?: string,
    entry = false,
    attachments?: PromptAttachment[],
    actor?: Actor,
  ) {
    void this.runStep(sessionId, feedback, entry, attachments, actor).catch((err) => {
      console.error(`[workflow ${sessionId}] step failed to start:`, err);
      const meta = this.sessions.get(sessionId);
      if (meta?.workflow) {
        meta.workflow.stepStatuses[meta.workflow.stepIndex] = 'waiting-approval';
        meta.workflow.stepFailure = 'pre-run';
      }
      this.sessions.failTurn(
        sessionId,
        `Step failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** What, in running `step` of `wf`, is still unverified — for the refusal text — or undefined. */
  private unverifiedRefusal(
    state: WorkflowState,
    wf: WorkflowDef,
    step: WorkflowDef['steps'][number],
  ): string | undefined {
    // A session's own snapshot: a guest's workflow when this machine attached it,
    // and otherwise whatever a synced row carried — `adoptSynced` marks one this
    // machine did not already hold. Any mark refuses it, strict or not: a session
    // row is never signed, so there is nothing a recovery switch could vouch for,
    // and nothing in the library to review it from.
    if (state.def) {
      return state.def.untrusted
        ? 'this session’s workflow came from another machine through cloud sync, and this machine has ' +
            'not verified it. Start a new session with a workflow from your library instead.'
        : undefined;
    }
    const label = isHeld(wf)
      ? `“${wf.name}”`
      : isStepRef(step) && isHeld(this.stepVersions.get(stepKey(step.ownerId, step.stepId, step.version)) ?? {})
        ? `the pinned step “${this.stepName(step)}”`
        : undefined;
    return label && `${label} has not been verified on this machine. Review it in Workflows, then Retry.`;
  }

  /** Resolved step name for transcript markers ('' if a ref couldn't be resolved). */
  private stepName(step?: WorkflowDef['steps'][number]): string {
    return (step && this.stepContent(step)?.name) || '';
  }

  /**
   * Charge spend the session billed to the step that was current while it was
   * spent: retries and iterations add to the same slot.
   *
   * Taken from the session on every settle, whatever its source, rather than read
   * off `lastCostUsd` for a workflow turn only — that left out the earlier
   * attempts of a re-driven turn, every result that landed while the step sat
   * parked (a background agent finishing), and re-added the previous turn's cost
   * when one ended with no result at all. A step that is not under way (pending,
   * or done) takes nothing: that spend is not the step's.
   */
  private chargeStep(
    meta: SessionMeta,
    i: number,
    spend: { costUsd: number; tokens: number } | undefined,
  ) {
    const wf = meta.workflow;
    if (!spend || !wf?.started) return;
    const status = wf.stepStatuses[i];
    if (status !== 'running' && status !== 'waiting-approval') return;
    if (spend.costUsd > 0) {
      const costs = (wf.stepCostsUsd ??= []);
      costs[i] = (costs[i] ?? 0) + spend.costUsd;
      // Which model that cost was spent on, so the stepper can tell a reported
      // figure from an estimated one per step — a provider-crossing workflow
      // stays in one SessionMeta, so meta.model only answers for the step
      // running now. Last writer wins: a retried step is marked by the model it
      // last ran on, which is the one the accumulated cost mostly came from.
      const models = (wf.stepModels ??= []);
      models[i] = resolveModelId(meta.model);
    }
    if (spend.tokens > 0) {
      const stepTokens = (wf.stepTokens ??= []);
      stepTokens[i] = (stepTokens[i] ?? 0) + spend.tokens;
    }
  }

  private onWorkflowTurnComplete(
    sessionId: string,
    source: 'user' | 'workflow',
    interrupted: boolean,
    failed: boolean,
  ) {
    // Taken whatever happens below, so spend outside any step is dropped here
    // rather than charged to whichever step comes next.
    const spent = this.sessions.takeUnreportedSpend(sessionId);
    const meta = this.sessions.get(sessionId);
    const wf = meta?.workflow && this.resolveFor(meta.workflow);
    if (!meta || !meta.workflow || !wf) return;
    const i = meta.workflow.stepIndex;
    const step = wf.steps[i];
    if (!step) return;
    this.chargeStep(meta, i, spent);
    if (meta.workflow.stepStatuses[i] !== 'running') {
      // A parked step can still run a turn: a manual compaction (see
      // sessions.compactContext). Anything the user typed during it was queued, and
      // nothing releases it — maybeFlush skips 'waiting-approval', which the settle
      // has just restored. Drain it into the same step, exactly as the park path
      // below does, rather than letting it strand.
      // isSessionInterruptible, not isSessionActive: the restored status *is* the park
      // (or 'error' for a failed step), and both are active. Only a live turn blocks.
      if (
        meta.workflow.stepStatuses[i] === 'waiting-approval' &&
        !isSessionInterruptible(meta.status)
      ) {
        const held = this.sessions.takeQueuedText(sessionId);
        if (held) this.iterateStep(sessionId, held.text, held.attachments);
      }
      return;
    }

    // A pending advance only counts for the step it was flagged for: an abandoned
    // turn settling late (see the force-advance watchdog) must not advance or park
    // whatever step is current by then. Metas from an older build carry no stamp.
    const stamped = (meta.workflow.advanceOnCompleteStep ?? i) === i;
    const forced = meta.workflow.advanceOnComplete === 'interrupted' && stamped;
    // A user-source turn can be live while the step still reads 'running' (a worker
    // error skipped the settle, then the user typed). It does nothing here except
    // consume an explicit force-advance stamped for this step — otherwise that step
    // would sit at 'running' forever.
    if (source !== 'workflow' && !forced) return;
    this.clearSettleWatchdog(sessionId); // any settle for this step ends the watchdog's job

    if (source === 'workflow') {
      // Accumulate active-turn duration onto the step (retries add to the same
      // slot). Cost and tokens were charged above, from every result the step's
      // turns settled rather than this one alone.
      const durationMs = meta.lastDurationMs;
      if (typeof durationMs === 'number') {
        const durations = (meta.workflow.stepDurationsMs ??= []);
        durations[i] = (durations[i] ?? 0) + durationMs;
      }
    }

    // Stop is explicit intent to halt, so it overrides both advance paths below: a
    // pending plan-approval advance is discarded and autoAdvance is ignored. Only an
    // explicit force-advance survives — that user asked for exactly this advance, and
    // forceAdvance reaches here through interrupt() by design.
    if (interrupted && !forced) {
      meta.workflow.advanceOnComplete = undefined;
      meta.workflow.advanceOnCompleteStep = undefined;
    } else if (meta.workflow.advanceOnComplete && stamped) {
      // A plan approved mid-step — or a force-advance of a running step — advances
      // straight to the next step.
      const event = meta.workflow.advanceOnComplete === 'interrupted' ? 'interrupted' : 'approved';
      meta.workflow.advanceOnComplete = undefined;
      meta.workflow.advanceOnCompleteStep = undefined;
      this.marker(sessionId, { stepIndex: i, stepName: this.stepName(step), event });
      void this.advance(sessionId);
      return;
    } else if (!failed && this.stepContent(step)?.autoAdvance) {
      // A failed turn produced no deliverable to hand on, so it parks below instead
      // — an explicit force-advance above still wins, that user asked for it.
      void this.advance(sessionId);
      return;
    }

    // A follow-up the user sent while the step was still running supersedes the
    // park: re-run the same step with it instead of stranding it in the queue.
    const queued = this.sessions.takeQueuedText(sessionId);
    if (queued) {
      this.iterateStep(sessionId, queued.text, queued.attachments);
      return;
    }

    meta.workflow.stepStatuses[i] = 'waiting-approval';
    if (failed) {
      // Keep the 'error' status + message the failed result already wrote, so the
      // session reads as failed and Retry stays live; the step still parks so Approve
      // can skip it. setStatus is what clears errorMessage (see sessions.setStatus),
      // so it is deliberately not called on this path.
      meta.workflow.stepFailure = 'turn';
      this.sessions.persistMeta(sessionId);
    } else {
      meta.workflow.stepFailure = undefined;
      this.sessions.setStatus(sessionId, 'waiting-approval');
    }
    this.marker(sessionId, {
      stepIndex: i,
      stepName: this.stepName(step),
      event: 'waiting-approval',
      ...(failed ? { failed: true } : {}),
    });
  }

  /**
   * A Retry click on a workflow session whose current step *failed*. Returns true if
   * it consumed the click; false falls through to SessionManager.retryTurn, which is
   * the right handler for a plain session (and for a workflow session whose step
   * didn't fail).
   *
   * The two failure kinds re-run different things: a 'pre-run' failure never got a
   * prompt, so the step is re-rendered from WorkflowState; a 'turn' failure has a
   * prompt in the transcript, so it is re-sent as a follow-up on the same step.
   */
  retryIfFailed(sessionId: string): boolean {
    const meta = this.sessions.get(sessionId);
    const failure = meta?.workflow?.stepFailure;
    if (!meta?.workflow || !failure) return false;
    // An advance mid-consolidation is about to bump past this step — re-running it
    // now would race that.
    if (meta.workflow.advancing) return false;
    if (isSessionActive(meta.status)) return false;
    const i = meta.workflow.stepIndex;
    if (meta.workflow.stepStatuses[i] !== 'waiting-approval') return false;
    if (failure === 'pre-run') {
      // No prompt was ever sent for this step: re-enter it exactly as the advance
      // would have, hand-off included.
      this.runStepSafely(sessionId, undefined, true);
      return true;
    }
    const last = this.sessions.lastPromptForRetry(sessionId);
    if (!last) return false;
    this.iterateStep(sessionId, last.text, last.attachments);
    return true;
  }

  /**
   * A free-text prompt sent while a step is parked at waiting-approval iterates
   * on the SAME step (never advances). Returns true if it consumed the prompt.
   */
  iterateIfWaiting(
    sessionId: string,
    text: string,
    attachments?: PromptAttachment[],
    /** Who typed it. This path intercepts a real person's prompt before
     *  SessionManager.userPrompt ever sees it, so attribution has to be threaded
     *  here too — otherwise every prompt in a workflow-driven session is authored
     *  by nobody. */
    actor?: Actor,
  ): boolean {
    const meta = this.sessions.get(sessionId);
    if (!meta?.workflow) return false;
    // A parked step can have a live turn over it — a manual compaction. Pushing a
    // second turn under it would race the in-flight `/compact`, so fall through to
    // SessionManager.userPrompt, which stages the prompt on the queue;
    // onWorkflowTurnComplete drains it back into this step when the compaction
    // settles. isSessionInterruptible, not isSessionActive: the park itself is active.
    if (isSessionInterruptible(meta.status)) return false;
    const i = meta.workflow.stepIndex;
    if (meta.workflow.stepStatuses[i] !== 'waiting-approval') return false;
    this.iterateStep(sessionId, text, attachments, actor);
    return true;
  }

  /** Re-run the current step as a plain follow-up turn (same conversation, no advance). */
  private iterateStep(
    sessionId: string,
    text: string,
    attachments?: PromptAttachment[],
    actor?: Actor,
  ) {
    const meta = this.sessions.get(sessionId);
    const wf = meta?.workflow && this.resolveFor(meta.workflow);
    if (!meta || !meta.workflow || !wf) return;
    const i = meta.workflow.stepIndex;
    meta.workflow.stepStatuses[i] = 'running';
    meta.workflow.stepFailure = undefined; // this attempt is judged on its own
    this.sessions.setStatus(sessionId, 'running');
    this.marker(sessionId, {
      stepIndex: i,
      stepName: this.stepName(wf.steps[i]),
      event: 'retried',
    });
    this.sessions.prompt(sessionId, text, 'workflow', attachments, [], actor);
  }

  approve(sessionId: string, stepIndex: number) {
    const meta = this.sessions.get(sessionId);
    if (!meta?.workflow) return;
    const i = meta.workflow.stepIndex;
    // Ignore a stale approve (e.g. a duplicate or a second tab showing an old
    // card): only act when it targets the step that is actually parked now.
    if (stepIndex !== i) return;
    if (meta.workflow.stepStatuses[i] !== 'waiting-approval') return;
    // A live turn over a parked step is a manual compaction (see compactContext).
    // Advancing under it would consolidate the step's output while the CLI is still
    // rewriting its own context, and then prompt the next step into the same query.
    if (isSessionInterruptible(meta.status)) return;
    const wf = this.resolveFor(meta.workflow);
    this.marker(sessionId, {
      stepIndex: i,
      stepName: this.stepName(wf?.steps[i]),
      event: 'approved',
    });
    void this.advance(sessionId);
  }

  /**
   * "Mark as completed" from the stepper. A parked step takes the same path as
   * Approve. A still-running step flags `advanceOnComplete` here and then stops
   * the turn, so the advance happens only once that turn settles; advancing under
   * a live turn lets the old query's late result clobber the next step. `interrupt()`
   * itself implies nothing (see docs/codebase/features/workflow-step-lifecycle.md).
   *
   * The flag is stamped with the step it was raised for, so a settle for any other
   * step ignores it — and a watchdog advances anyway if no settle ever arrives. One
   * click must always end on the next step.
   */
  forceAdvance(sessionId: string, stepIndex: number) {
    const meta = this.sessions.get(sessionId);
    if (!meta?.workflow?.started) return;
    const i = meta.workflow.stepIndex;
    // Ignore a stale click (duplicate, or a second tab showing an older stepper).
    if (stepIndex !== i) return;
    const status = meta.workflow.stepStatuses[i];
    if (status === 'waiting-approval') {
      this.approve(sessionId, i);
      return;
    }
    if (status === 'done') {
      // The advance marked this step done but never bumped past it (see advance's
      // persist). `advancing` is the only marker of a live advance, so a cleared flag
      // means nothing is coming to finish this one — re-enter advance, which
      // re-consolidates the output and starts the next step.
      if (meta.workflow.advancing) return;
      // Deliberately isSessionInterruptible and not isSessionActive: this branch has
      // to survive the stale 'waiting-approval' a died-mid-advance session carries
      // (see WorkflowStepper's `resumable`). A *live* turn here is a compaction.
      if (isSessionInterruptible(meta.status)) return;
      const done = this.resolveFor(meta.workflow);
      // The last step reading 'done' is a finished workflow, not a stall.
      if (!done || i + 1 >= done.steps.length) return;
      void this.advance(sessionId);
      return;
    }
    if (status !== 'running') return;
    if (isSessionActive(meta.status)) {
      // Flagged whatever the turn's source: a user-source turn can be live while the
      // step still reads 'running' (a worker error skipped the settle, then the user
      // typed), and refusing to flag there left the step stranded at 'running'
      // forever. The step stamp — not the turn source — is what keeps a stale flag
      // from skipping a later step's park.
      meta.workflow.advanceOnComplete = 'interrupted';
      meta.workflow.advanceOnCompleteStep = i;
      this.sessions.interrupt(sessionId);
      this.armSettleWatchdog(sessionId, i);
      return;
    }
    // Marked running with no turn in flight (e.g. the worker died mid-step): no
    // late result can arrive, so advance straight away.
    const wf = this.resolveFor(meta.workflow);
    this.marker(sessionId, {
      stepIndex: i,
      stepName: this.stepName(wf?.steps[i]),
      event: 'approved',
    });
    void this.advance(sessionId);
  }

  /**
   * "Start this step" from the stepper. An advance can land on a step without ever
   * queueing its first turn — the bridge died mid-advance, or runStep bailed — and
   * then the step sits 'pending' with nothing in flight, so no settle is ever coming
   * to move it. Runs it as a normal step entry, hand-off included, so it proceeds
   * exactly as the advance would have.
   */
  startStep(sessionId: string, stepIndex: number) {
    const meta = this.sessions.get(sessionId);
    // Before the first prompt there is no task to substitute — that prompt starts step 0.
    if (!meta?.workflow?.started) return;
    const i = meta.workflow.stepIndex;
    // Ignore a stale click (duplicate, or a second tab showing an older stepper).
    if (stepIndex !== i) return;
    // Only a step that never started: 'running' belongs to forceAdvance, and a parked
    // step to approve/retry.
    if (meta.workflow.stepStatuses[i] !== 'pending') return;
    // A live turn or an advance mid-consolidation is already on its way to starting it.
    if (isSessionActive(meta.status) || meta.workflow.advancing) return;
    this.runStepSafely(sessionId, undefined, true);
  }

  /**
   * A force-advance hands the advance to whatever settles the interrupted turn — a
   * `result`, or an `ended` for a query that dies without one. A wedged worker emits
   * neither, and the step would then sit at 'running' forever, so advance it here.
   *
   * Clearing `turnSource` is load-bearing: a very late result from the abandoned turn
   * then settles as 'user' with the stamp already consumed, which onWorkflowTurnComplete
   * ignores — so it can neither advance nor park the *next* step.
   */
  private armSettleWatchdog(sessionId: string, i: number) {
    this.clearSettleWatchdog(sessionId);
    const timer = setTimeout(() => {
      this.settleWatchdogs.delete(sessionId);
      const meta = this.sessions.get(sessionId);
      const wf = meta?.workflow && this.resolveFor(meta.workflow);
      if (!meta || !meta.workflow || !wf) return;
      // Bail unless nothing has moved since the click: the flag is still ours, the
      // step is still the current running one, and no turn is live — a session back
      // to active means the user (or a recovery path) re-prompted, and that turn's own
      // settle owns the advance.
      if (meta.workflow.advanceOnComplete !== 'interrupted') return;
      if (meta.workflow.advanceOnCompleteStep !== i) return;
      if (meta.workflow.stepIndex !== i) return;
      if (meta.workflow.stepStatuses[i] !== 'running') return;
      if (isSessionActive(meta.status)) return;
      meta.turnSource = undefined;
      meta.workflow.advanceOnComplete = undefined;
      meta.workflow.advanceOnCompleteStep = undefined;
      this.marker(sessionId, {
        stepIndex: i,
        stepName: this.stepName(wf.steps[i]),
        event: 'interrupted',
      });
      void this.advance(sessionId);
    }, this.forceAdvanceSettleMs);
    timer.unref?.(); // never hold the process open on a pending advance
    this.settleWatchdogs.set(sessionId, timer);
  }

  private clearSettleWatchdog(sessionId: string) {
    const timer = this.settleWatchdogs.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.settleWatchdogs.delete(sessionId);
  }

  retry(sessionId: string, stepIndex: number, feedback: string) {
    const meta = this.sessions.get(sessionId);
    if (!meta?.workflow) return;
    const i = meta.workflow.stepIndex;
    if (stepIndex !== i) return;
    if (meta.workflow.stepStatuses[i] !== 'waiting-approval') return;
    this.runStepSafely(sessionId, feedback);
  }

  private async advance(sessionId: string) {
    const meta = this.sessions.get(sessionId);
    const wf = meta?.workflow && this.resolveFor(meta.workflow);
    if (!meta || !meta.workflow || !wf) return;
    const i = meta.workflow.stepIndex;
    meta.workflow.stepStatuses[i] = 'done';
    meta.workflow.stepFailure = undefined; // the workflow is moving on from this step
    // Consolidating an iterated step runs a real query, so the gap before the next
    // step starts is seconds long with nothing else broadcast in it. Raise the
    // in-flight flag *before* the await — every path from the WS handler to here is
    // synchronous, so the client sees it in the same tick as the click.
    meta.workflow.advancing = true;
    this.sessions.persistMeta(sessionId);

    try {
      // Consolidate this step's final output (single-turn steps return their last
      // text as-is; iterated steps fold every attempt into one deliverable). Kept
      // for the {previous} hand-off, and published under the step's name so later
      // steps can pull it via {outputs.<name>}.
      const output = await this.sessions.consolidateStepOutput(sessionId, i);
      // An empty capture is not a deliverable — publishing it would clobber a
      // previous non-empty value and hand the next step nothing.
      if (output.trim()) {
        meta.workflow.lastStepOutput = output;
        const outName = this.stepContent(wf.steps[i])?.outputName?.trim();
        if (outName) {
          (meta.workflow.outputs ??= {})[outName] = output;
        }
        // Persist the capture before the next step is queued: otherwise it rides on
        // whatever setStatus happens next and is lost if the bridge dies in between.
        this.sessions.persistMeta(sessionId);
      }
    } catch (err) {
      // consolidateStepOutput catches internally, so this is insurance only. Swallowed
      // rather than rethrown: every caller does `void this.advance(...)`, so a rejection
      // here would be an unhandled rejection — and the flow below still clears the
      // in-flight flag and starts the next step, which beats a stuck loader.
      console.warn('[workflow advance]', err);
    }

    // Cleared without its own broadcast: both branches below broadcast next with no
    // await in between (runStep's setStatus('running') / its error branch, or the
    // final setStatus('idle')), so the clear rides that message and the button never
    // flickers back to live. An await inserted between here and those calls reopens
    // that window.
    meta.workflow.advancing = false;

    if (i + 1 < wf.steps.length) {
      meta.workflow.stepIndex = i + 1;
      // Persisted before handing off to runStep. Until this lands, the durable state is
      // `stepStatuses[i] === 'done'` with `stepIndex` still `i`, and a bridge death in
      // that window (a consolidation that outlived the process, say) leaves a step no
      // affordance can move: approve/retry want 'waiting-approval', forceAdvance wants
      // 'running', startStep wants 'pending'. Synchronous, so it cannot reopen the
      // `advancing` flicker window the comment above guards.
      this.sessions.persistMeta(sessionId);
      this.runStepSafely(sessionId, undefined, true);
    } else {
      this.sessions.setStatus(sessionId, 'idle');
      this.marker(sessionId, {
        stepIndex: i,
        stepName: this.stepName(wf.steps[i]),
        event: 'workflow-done',
      });
    }
  }
}
