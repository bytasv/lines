/**
 * The recipe command layer — the parts of running a recipe that are easy to get
 * wrong and must not be re-derived per entry point.
 *
 * `UserContext` is imported type-only: userContext.ts builds the engine and the
 * sync client this module drives, so a value import would be a cycle (same
 * reason as workflowCommands.ts).
 */
import { randomUUID } from 'node:crypto';
import type { ClientMessage, PermissionMode, RecipeDef, ServerMessage } from '@lines/shared';
import { FOREIGN_RECIPE_MODES, findProject, RECIPE_BUNDLE_MAX } from '@lines/shared';
import { isHeld } from './syncSignature.ts';
import type { UserContext } from './userContext.ts';

type RunRecipeMsg = Extract<ClientMessage, { type: 'runRecipe' }>;

/** Version history for one recipe: pull remote (if online), adopt it, then read locally. */
export async function recipeVersionsView(
  ctx: UserContext,
  ownerId: string,
  recipeId: string,
): Promise<RecipeDef[]> {
  const remote = await ctx.sync.pullRecipeVersions(ownerId, recipeId);
  // Only the history that was asked for (see addRecipeVersions).
  if (remote) ctx.recipes.addRecipeVersions(remote, [{ ownerId, id: recipeId }]);
  return ctx.recipes.listRecipeVersions(ownerId, recipeId);
}

/**
 * Did the user confirm exactly the prompts about to run, in run order? Compared
 * against the bridge's own expansion, never used in its place: the client
 * cannot choose what runs, only prove it saw it.
 */
function confirmedExactly(confirmed: unknown, leaves: RecipeDef[]): boolean {
  return (
    Array.isArray(confirmed) &&
    confirmed.length === leaves.length &&
    leaves.every((r, i) => confirmed[i] === r.prompt)
  );
}

/**
 * Run one recipe, an ad-hoc selection, or a saved bundle — always in a brand new
 * session. Returns the session id, or null when the cooldown swallowed a
 * repeated click.
 *
 * The order here is load-bearing: everything that can refuse the run happens
 * before anything observable exists, and the run counter is bumped last. So a
 * rejected run can never leave a count, a session, or a half-configured
 * workflow behind — and a bundle that cannot fully resolve leaves nothing at all.
 */
export function runRecipe(ctx: UserContext, msg: RunRecipeMsg): string | null {
  const { recipes, workflows, sessions, store, broadcast } = ctx;
  if (msg.recipes.length === 0) throw new Error('Nothing to run');
  // A bundle *is* a workflow, so it cannot also run inside a chosen one.
  // Rejected rather than silently picking one of the two.
  if (msg.recipes.length > 1 && msg.workflowId) throw new Error('A bundle already is a workflow');
  // Resolves every ref and splices any saved bundle's members in place, throwing
  // and naming the first one that is no longer available — all-or-nothing.
  const { leaves, bundles } = recipes.expandForRun(msg.recipes);
  // Re-checked post-expansion: a single ref can turn out to be a saved bundle.
  if (leaves.length > 1 && msg.workflowId) throw new Error('A bundle already is a workflow');
  // Post-expansion too, since a bundle can expand past the cap the client saw.
  if (leaves.length > RECIPE_BUNDLE_MAX) throw new Error(`A run holds at most ${RECIPE_BUNDLE_MAX} recipes`);

  // An own recipe this machine has not verified — pulled unsigned, forged, or
  // signed by a machine the account does not trust — does not run, however it
  // was reached: directly, or as a member of a bundle.
  const unverified = [...bundles, ...leaves].find(isHeld);
  if (unverified) {
    throw new Error(`“${unverified.title}” has not been verified on this machine — review it in Recipes before running it.`);
  }
  // Someone else's prompt runs with less authority, and only once seen. Each of
  // these is decided here rather than trusted from the modal, which applies the
  // same rules only so the user is never surprised by this.
  const foreign = [...leaves, ...bundles].some((r) => r.ownerId !== ctx.userId);
  if (foreign) {
    // A chosen workflow brings its own permission mode per step, and its first
    // step would carry this prompt as the task.
    if (msg.workflowId) {
      throw new Error("Someone else's recipe runs in a session of its own, not inside one of your workflows.");
    }
    if (!confirmedExactly(msg.confirmedPrompts, leaves)) {
      throw new Error("Read the full prompt of someone else's recipe and confirm it before running it.");
    }
  }
  // A chosen workflow is checked before the session it would be attached to
  // exists, so a refusal leaves nothing behind (attach would throw too, later).
  if (msg.workflowId) workflows.assertRunnable(msg.workflowId);
  // Never more than plan or ask-every-time for a stranger's prompt, whatever the
  // runner's default mode is.
  const permissionMode: PermissionMode =
    foreign && !FOREIGN_RECIPE_MODES.includes(msg.permissionMode) ? 'default' : msg.permissionMode;
  // A run with someone else's recipe in it parks after every step, so each next
  // prompt runs only when the user has seen what the last one did. One made only
  // of the user's own (verified) recipes keeps the choice the modal offers: those
  // are their own instructions.
  const autoAdvance = foreign ? false : (msg.autoAdvance ?? true);

  // Keyed on the expanded set, so re-running the same effective recipes is
  // debounced whether they arrived ad-hoc or via a bundle. Stamped only after
  // every refusal above, so a corrected retry is not swallowed as a double-click.
  const keys = leaves.map((r) => `${r.ownerId}/${r.id}`);
  if (!recipes.runAllowed(keys.join('|'))) return null;
  // No open project means no usable cwd, so no session is created at all — the
  // same rule the sidebar's create button applies.
  // Any root of an open project counts, not just its primary: a run started from
  // an extra root has a perfectly usable cwd.
  if (!findProject(store.loadProjects(), msg.cwd)) throw new Error('Open a project first to run a recipe');

  const bundle = bundles[0];
  const multi = leaves.length > 1;
  const runName = msg.bundleName?.trim() || bundle?.title || `${leaves[0].title} +${leaves.length - 1} more`;
  // Saved *before* the session, so `attach` can resolve it. Persistence is
  // load-bearing rather than incidental: every WorkflowEngine lifecycle method
  // re-resolves the def by id on each transition, so an unsaved def turns each
  // of them into a silent no-op — the prompt swallowed, no stepper, a dead
  // session. Never "optimize" this into an ephemeral workflow.
  const wf = multi
    ? workflows.save({
        id: randomUUID(),
        name: runName,
        published: false,
        steps: leaves.map((r) => ({
          name: r.title,
          promptTemplate: r.prompt,
          // Recipes carry neither, so both come from the run modal.
          model: msg.model,
          permissionMode,
          autoAdvance,
          // Cumulative by definition: step N has to see what step N-1 built,
          // which is also why no hand-off tokens are needed.
          freshStart: false,
        })),
      })
    : undefined;

  const meta = sessions.createSession({
    name: (multi ? runName : leaves[0].title).slice(0, 60),
    cwd: msg.cwd,
    model: msg.model,
    permissionMode,
  });
  // The name is deliberate, so the auto-titler must not overwrite it.
  meta.nameAuto = false;
  // Approving a plan normally resumes in `auto`, which a stranger's prompt may
  // not reach: the ceiling makes that approval resume in `default` instead.
  if (foreign) meta.permissionCeiling = 'default';
  sessions.persistMeta(meta.id);

  if (wf) {
    workflows.attach(meta.id, wf.id);
    // The recipe prompts are the step templates here, so the first prompt is only
    // ever `{task}` — and no synthesized template references it. A short readable
    // line keeps the transcript's opening meaningful.
    const task = bundle?.description?.trim() || `Set up: ${leaves.map((r) => r.title).join(', ')}`;
    workflows.startIfPending(meta.id, task);
  } else if (msg.workflowId) {
    workflows.attach(meta.id, msg.workflowId);
    workflows.startIfPending(meta.id, leaves[0].prompt);
  } else {
    sessions.userPrompt(meta.id, leaves[0].prompt);
  }

  // Only now that injection returned without throwing. A bundle and each of its
  // members are separate facts ("this bundle ran 40 times", "this auth recipe ran
  // 200 times, 40 of them via that bundle"), so both count.
  // One increment per identity, even when it ran twice: `ON CONFLICT DO UPDATE`
  // cannot touch the same row twice in one statement, and two selected bundles can
  // legitimately share a member. Deduping here rather than in `leaves` keeps the
  // optimistic count equal to the authoritative one — offline it is never corrected.
  const pairs: { ownerId: string; id: string }[] = [];
  const counted = new Set<string>();
  for (const r of [...leaves, ...bundles]) {
    const key = `${r.ownerId}/${r.id}`;
    if (counted.has(key)) continue;
    counted.add(key);
    pairs.push({ ownerId: r.ownerId, id: r.id });
  }
  const stats: Record<string, number> = {};
  for (const p of pairs) {
    const key = `${p.ownerId}/${p.id}`;
    // Optimistic, so an offline storage still shows n+1 immediately.
    stats[key] = recipes.bumpStat(key);
  }
  broadcast({ type: 'recipeStats', stats } satisfies ServerMessage);
  // One batched call, not one per recipe; authoritative numbers replace the
  // optimistic ones when they land.
  void ctx.sync.incrementRecipeRuns(pairs).then((authoritative) => {
    if (!authoritative) return;
    recipes.applyStats(authoritative);
    broadcast({ type: 'recipeStats', stats: authoritative } satisfies ServerMessage);
  });
  return meta.id;
}
