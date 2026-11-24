import type { PermissionMode, ProjectSessionPrefs, ReasoningEffort, WorkflowStepOverride } from '@lines/shared';
import { activeGroupKey, prefsFor, useStore, type ReplaceOnCreate } from '../store';
import { send } from '../ws';
import { useLaunchableWorkflows } from './useLaunchableWorkflows';

export interface CreateSessionOptions {
  stepOverrides?: (WorkflowStepOverride | null)[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
  permissionMode?: PermissionMode;
  /** Absent = the project's "Run in a new worktree" switch. */
  worktree?: boolean;
  /** A fresh session this one stands in for, deleted once it lands. */
  replaces?: ReplaceOnCreate;
}

/** The active project's new-session prefs, and a setter that merges into them. */
function useProjectPrefs() {
  const prefsKey = useStore(activeGroupKey);
  const sessionPrefs = useStore((s) => s.sessionPrefs);
  const legacySidebarMode = useStore((s) => s.sidebarMode);
  const setSessionPrefs = useStore((s) => s.setSessionPrefs);
  const prefs = prefsFor({ sessionPrefs, sidebarMode: legacySidebarMode }, prefsKey);
  const set = (patch: ProjectSessionPrefs) => {
    if (prefsKey) setSessionPrefs(prefsKey, patch);
  };
  return [prefs, set] as const;
}

/** The project's new-session worktree switch, and its setter. */
export function useWorktreePref(): [boolean, (on: boolean) => void] {
  const [prefs, set] = useProjectPrefs();
  return [prefs.worktree, (worktree) => set({ worktree })];
}

/**
 * The workflow a new session opens with ('' = bare): the last one picked on the
 * new-session view, so a repeat run is one click and "Bare session" is the
 * deliberate way out.
 */
export function useNewSessionChoice(): [string, (workflowId: string) => void] {
  const [prefs, set] = useProjectPrefs();
  return [prefs.newSessionChoice, (newSessionChoice) => set({ newSessionChoice })];
}

/**
 * Attach a workflow to a fresh session (or `null`: back to bare) and remember
 * it as the next new session's choice. False when the workflow cannot travel
 * from here; the reason is in `actionError`.
 */
export function useSetPendingWorkflow() {
  const { launchFor } = useLaunchableWorkflows();
  const setActionError = useStore((s) => s.setActionError);
  const [, setChoice] = useNewSessionChoice();
  return (
    sessionId: string,
    workflowId: string | null,
    stepOverrides?: (WorkflowStepOverride | null)[],
  ): boolean => {
    if (workflowId === null) {
      send({ type: 'setPendingWorkflow', sessionId, workflowId: null });
      setChoice('');
      return true;
    }
    const launch = launchFor(workflowId);
    if (!launch.ok) {
      setActionError(launch.error);
      return false;
    }
    setActionError(null);
    send({
      type: 'setPendingWorkflow',
      sessionId,
      workflowId,
      ...(launch.workflowDef ? { workflowDef: launch.workflowDef } : {}),
      ...(stepOverrides?.some(Boolean) ? { stepOverrides } : {}),
    });
    setChoice(workflowId);
    return true;
  };
}

/**
 * Launch a new session in the active project. Anything left out of `opts` comes
 * from the new-session defaults and the worktree switch. `reasoningEffort`
 * counts when present as a key, even undefined (= Auto). Returns false when
 * nothing was sent (no project, or a workflow that cannot travel from here —
 * the reason is in `actionError`).
 */
export function useCreateSession() {
  const activeProject = useStore((s) => s.activeProject);
  const newSessionDefaults = useStore((s) => s.newSessionDefaults);
  const markSessionCreatePending = useStore((s) => s.markSessionCreatePending);
  const setActionError = useStore((s) => s.setActionError);
  const setWorktreePending = useStore((s) => s.setWorktreePending);
  const { launchFor } = useLaunchableWorkflows();
  const [worktreeMode] = useWorktreePref();

  return (workflowId?: string, opts?: CreateSessionOptions): boolean => {
    if (!activeProject) return false;
    const stepOverrides = opts?.stepOverrides;
    const worktree = opts?.worktree ?? worktreeMode;
    const reasoningEffort =
      opts && 'reasoningEffort' in opts ? opts.reasoningEffort : newSessionDefaults.reasoningEffort;
    // The user's own workflow, on a machine whose library does not have it: it
    // travels inline, every step resolved here, since the host cannot.
    const launch = workflowId ? launchFor(workflowId) : ({ ok: true } as const);
    if (!launch.ok) {
      setActionError(launch.error);
      return false;
    }
    const workflowDef = 'workflowDef' in launch ? launch.workflowDef : undefined;
    // Records the intent that lets the resulting upsert take the selection; the
    // reducer no longer guesses from `createdAt` (a timestamp from another machine).
    markSessionCreatePending(opts?.replaces ?? null);
    // `worktree add` is a multi-second git operation the server awaits before the
    // session exists, so the button has to stay busy — a second click would cut a
    // second work tree.
    if (worktree) {
      setActionError(null);
      setWorktreePending(true);
    }
    send({
      type: 'createSession',
      name: 'New session',
      cwd: activeProject,
      model: opts?.model ?? newSessionDefaults.model,
      permissionMode: opts?.permissionMode ?? newSessionDefaults.permissionMode,
      reasoningEffort,
      workflowId,
      ...(workflowDef ? { workflowDef } : {}),
      ...(workflowId && stepOverrides?.some(Boolean) ? { stepOverrides } : {}),
      // Empty object = let the server name the branch and the path.
      ...(worktree ? { worktree: {} } : {}),
    });
    return true;
  };
}
