import { useCallback } from 'react';
import {
  resolveStepContent,
  type StepContent,
  type StepDef,
  type WorkflowDef,
  type WorkflowStep,
} from '@lines/shared';
import { useStore } from '../store';

/**
 * Resolve workflows and their steps on this client. Workflows come from the
 * user's own list, then the shared one. Steps resolve inline as-is, refs through
 * the pinned versions, the user's own library and shared steps — the exact pin
 * first, else the step's latest version known here.
 */
export function useStepResolver() {
  const pinnedSteps = useStore((s) => s.pinnedSteps);
  const sharedSteps = useStore((s) => s.sharedSteps);
  const libSteps = useStore((s) => s.steps);
  const workflows = useStore((s) => s.workflows);
  const sharedWorkflows = useStore((s) => s.sharedWorkflows);

  const findWorkflow = useCallback(
    (id: string): WorkflowDef | undefined =>
      workflows.find((w) => w.id === id) ?? sharedWorkflows.find((w) => w.id === id),
    [workflows, sharedWorkflows],
  );

  const lookup = useCallback(
    (ownerId: string, stepId: string, version: number): StepDef | undefined => {
      const all = [...pinnedSteps, ...libSteps, ...sharedSteps];
      return (
        all.find((d) => d.ownerId === ownerId && d.id === stepId && d.version === version) ??
        all.find((d) => d.ownerId === ownerId && d.id === stepId)
      );
    },
    [pinnedSteps, libSteps, sharedSteps],
  );

  const resolve = useCallback(
    (step: WorkflowStep): StepContent | undefined => resolveStepContent(step, lookup),
    [lookup],
  );

  return { findWorkflow, lookup, resolveStepContent: resolve };
}
