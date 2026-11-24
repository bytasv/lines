import { useMemo } from 'react';
import type { WorkflowDef } from '@lines/shared';
import { useStore } from '../store';
import { inlineWorkflow } from './machines';

/** What a launch of one workflow sends: inline def for the user's own on a shared machine. */
export type WorkflowLaunch = { ok: true; workflowDef?: WorkflowDef } | { ok: false; error: string };

/**
 * The workflows a new session (or the new-session picker) can run, split the
 * way the launch menus show them.
 *
 * On a shared machine `workflows` is the host's library, and the user's own
 * comes from their own machine's slice (when one is loaded). A workflow picked
 * from it runs on the host as an inline snapshot (see `createSession`).
 */
export function useLaunchableWorkflows() {
  const workflows = useStore((s) => s.workflows);
  const sharedWorkflows = useStore((s) => s.sharedWorkflows);
  const access = useStore((s) => s.access);
  const hostProfile = useStore((s) => (s.access ? s.machines[s.primaryDeviceId ?? '']?.ownerProfile : null));
  const ownView = useStore((s) =>
    s.access ? Object.values(s.machines).find((m) => !m.view.access)?.view : undefined,
  );
  const hostName = access ? (hostProfile?.name ?? hostProfile?.email ?? 'Host') : null;
  const ownWorkflows = useMemo(
    () =>
      (ownView?.workflows ?? []).filter(
        (o) => !workflows.some((w) => w.id === o.id) && !sharedWorkflows.some((w) => w.id === o.id),
      ),
    [ownView, workflows, sharedWorkflows],
  );
  // An id present in both lists is owned — it must not also appear under
  // "Shared by others", where picking it would read as running someone else's.
  // On a shared machine "owned" covers the user's own library too.
  const foreignWorkflows = useMemo(
    () =>
      sharedWorkflows.filter(
        (s) => !workflows.some((w) => w.id === s.id) && !(ownView?.workflows ?? []).some((w) => w.id === s.id),
      ),
    [sharedWorkflows, workflows, ownView],
  );
  /**
   * One of the user's own workflows made self-contained for the host, or why it
   * cannot be — null when it is not one of theirs. Refused when their own machine
   * holds any of it back: the host has no way to tell, so it must not travel.
   */
  const ownInline = (workflowId: string): ReturnType<typeof inlineWorkflow> | null => {
    const own = ownWorkflows.find((w) => w.id === workflowId);
    return own && ownView ? inlineWorkflow(own, ownView.steps, ownView.pinnedSteps, ownView.sharedSteps) : null;
  };
  /** The def a launch of `workflowId` runs, for picking its per-step models. */
  const resolveWorkflow = (workflowId: string): WorkflowDef | undefined => {
    // An own workflow on a shared machine is tuned in its inlined form: its refs
    // do not resolve against the host's step library.
    const inlined = ownWorkflows.some((w) => w.id === workflowId) ? ownInline(workflowId) : null;
    return (inlined?.ok ? inlined.def : null) ?? [...workflows, ...sharedWorkflows].find((w) => w.id === workflowId);
  };
  /** What to send for `workflowId`, or the reason it cannot be launched from here. */
  const launchFor = (workflowId: string): WorkflowLaunch => {
    if (!ownWorkflows.some((w) => w.id === workflowId)) return { ok: true };
    const inlined = ownInline(workflowId);
    if (inlined?.ok) return { ok: true, workflowDef: inlined.def };
    return {
      ok: false,
      error:
        inlined?.reason === 'unverified'
          ? 'Your machine has not verified everything this workflow runs. Review it there in Workflows first.'
          : 'One of this workflow’s shared steps is not available here.',
    };
  };
  /** Every workflow a launch can name, own first. */
  const all = useMemo(
    () => [...workflows, ...ownWorkflows, ...foreignWorkflows],
    [workflows, ownWorkflows, foreignWorkflows],
  );
  return { workflows, ownWorkflows, foreignWorkflows, hostName, all, resolveWorkflow, launchFor };
}
