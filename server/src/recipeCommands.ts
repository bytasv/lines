/**
 * The recipe command layer — the parts of running a recipe that are easy to get
 * wrong and must not be re-derived per entry point.
 *
 * `UserContext` is imported type-only: userContext.ts builds the engine and the
 * sync client this module drives, so a value import would be a cycle (same
 * reason as workflowCommands.ts).
 */
import { randomUUID } from 'node:crypto';
import type { ClientMessage, RecipeDef, ServerMessage } from '@lines/shared';
import { findProject, RECIPE_BUNDLE_MAX } from '@lines/shared';
import type { UserContext } from './userContext.ts';

type RunRecipeMsg = Extract<ClientMessage, { type: 'runRecipe' }>;

/** Version history for one recipe: pull remote (if online), adopt it, then read locally. */
export async function recipeVersionsView(
  ctx: UserContext,
  ownerId: string,
  recipeId: string,
): Promise<RecipeDef[]> {
  const remote = await ctx.sync.pullRecipeVersions(ownerId, recipeId);
  if (remote) ctx.recipes.addRecipeVersions(remote);
  return ctx.recipes.listRecipeVersions(ownerId, recipeId);
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

  // Keyed on the expanded set, so re-running the same effective recipes is
  // debounced whether they arrived ad-hoc or via a bundle.
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
          permissionMode: msg.permissionMode,
          autoAdvance: msg.autoAdvance ?? true,
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
    permissionMode: msg.permissionMode,
  });
  // The name is deliberate, so the auto-titler must not overwrite it.
  meta.nameAuto = false;
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
