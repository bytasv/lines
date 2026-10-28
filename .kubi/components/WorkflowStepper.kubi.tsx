import { WorkflowStepper } from '../../web/src/components/WorkflowStepper';
import { withComposerColumn, withSessionStore } from '../decorators';
import { SESSION_WORKFLOW } from '../fixtures';

// The step row above a workflow run's transcript: Plan → Build → Review, each
// with its model, status and cost, and the approve / advance controls.
const def = SESSION_WORKFLOW.workflow!.def!;
const run = (patch: Partial<NonNullable<typeof SESSION_WORKFLOW.workflow>>, status = SESSION_WORKFLOW.status) => ({
  ...SESSION_WORKFLOW,
  status,
  workflow: { ...SESSION_WORKFLOW.workflow!, ...patch },
});

export default {
  component: WorkflowStepper,
  title: 'Workflow/WorkflowStepper',
  argTypes: {
    session: { type: 'object' },
    workflow: { type: 'object' },
  },
  args: {
    session: SESSION_WORKFLOW,
    workflow: def,
  },
  decorators: [withComposerColumn, withSessionStore],
};

export const BuildRunning = {};
export const PlanAwaitingApproval = {
  args: {
    session: run({ stepIndex: 0, stepStatuses: ['waiting-approval', 'pending', 'pending'], stepCostsUsd: [] }, 'waiting-approval'),
  },
};
export const ReviewAwaitingApproval = {
  args: {
    session: run(
      {
        stepIndex: 2,
        stepStatuses: ['done', 'done', 'waiting-approval'],
        stepCostsUsd: [0.38, 1.12, 0.21],
        stepDurationsMs: [212_000, 641_000, 98_000],
      },
      'waiting-approval',
    ),
  },
};
