import type { WorkflowStep } from '@lines/shared';
import { DEFAULT_MODEL } from '@lines/shared';

export interface WorkflowPreset {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
}

// "Feature flow" mirrors the server's DEFAULT_WORKFLOW (server/src/workflows.ts).
// Kept as a client-side copy on purpose — revisit sharing the steps via shared/ later.
export const WORKFLOW_PRESETS: WorkflowPreset[] = [
  {
    id: 'feature-flow',
    name: 'Feature flow',
    description: 'Plan → MVP → Tests → Refactor → Review',
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
          'Implement the MVP of the planned feature now. Follow the approved plan. Keep the change minimal — no extras beyond the plan.{feedback}',
        model: 'claude-opus-5-5',
        permissionMode: 'acceptEdits',
        autoAdvance: false,
        freshStart: true,
      },
      {
        name: 'Add tests',
        promptTemplate:
          'Add tests covering the feature just implemented. Run them and make sure they pass.{feedback}',
        model: 'claude-sonnet-5-5',
        permissionMode: 'acceptEdits',
        autoAdvance: false,
        freshStart: true,
      },
      {
        name: 'Refactor',
        promptTemplate:
          'Refactor the new code for clarity and consistency with the rest of the codebase. Keep tests green.{feedback}',
        model: 'claude-sonnet-5-5',
        permissionMode: 'acceptEdits',
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
  },
  {
    id: 'bugfix-flow',
    name: 'Bugfix flow',
    description: 'Reproduce → Fix → Regression test → Review',
    steps: [
      {
        name: 'Reproduce',
        promptTemplate:
          'We are fixing a bug: {task}\n\nFirst reproduce it. Find the root cause and explain it. Do not fix anything yet.{feedback}',
        model: DEFAULT_MODEL,
        permissionMode: 'plan',
        autoAdvance: false,
        freshStart: false,
      },
      {
        name: 'Fix',
        promptTemplate:
          'Apply the smallest fix that addresses the root cause identified above.{feedback}',
        model: DEFAULT_MODEL,
        permissionMode: 'acceptEdits',
        autoAdvance: false,
        freshStart: true,
      },
      {
        name: 'Regression test',
        promptTemplate:
          'Add a regression test that fails without the fix and passes with it. Run it.{feedback}',
        model: 'claude-sonnet-5-5',
        permissionMode: 'acceptEdits',
        autoAdvance: false,
        freshStart: true,
      },
      {
        name: 'Review',
        promptTemplate:
          'Review the fix and the test for correctness and edge cases. Report findings; do not change code.{feedback}',
        model: DEFAULT_MODEL,
        permissionMode: 'plan',
        autoAdvance: false,
        freshStart: true,
      },
    ],
  },
  {
    id: 'explore-document',
    name: 'Explore & document',
    description: 'Explore codebase → Write docs',
    steps: [
      {
        name: 'Explore',
        promptTemplate:
          'Explore the codebase to understand: {task}\n\nMap the relevant files, flows, and key decisions. Do not change code.{feedback}',
        model: DEFAULT_MODEL,
        permissionMode: 'plan',
        autoAdvance: false,
        freshStart: false,
      },
      {
        name: 'Write docs',
        promptTemplate:
          'Write clear documentation for what you explored above. Match the style of existing docs in the repo.{feedback}',
        model: 'claude-sonnet-5-5',
        permissionMode: 'acceptEdits',
        autoAdvance: false,
        freshStart: true,
      },
    ],
  },
];
