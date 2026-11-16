import { useEffect, useState } from 'react';
import { Button, Group, Modal, NumberInput, SegmentedControl, Stack, Text, Textarea } from '@mantine/core';
import type { GoalOnMet, SessionMeta } from '@lines/shared';
import { clampGoalMaxTurns, GOAL_DEFAULT_MAX_TURNS, GOAL_MAX_TURNS_LIMIT } from '@lines/shared';
import { isWorkflowFinished } from '../lib/format';
import { useStepResolver } from '../lib/useStepResolver';
import { send } from '../ws';
import { GOAL_ON_MET_DATA } from './workflow/WorkflowRunModal';

/**
 * Set, edit or resume a goal. On a session running a workflow it is the current
 * step's goal — with a choice of what happens once it is met — and otherwise the
 * session's. Prefilled from the goal already there; saving always sends
 * `setGoal`, which also resumes a paused goal with a fresh turn budget.
 */
export function GoalModal({
  session,
  opened,
  onClose,
}: {
  session: SessionMeta;
  opened: boolean;
  onClose: () => void;
}) {
  const { findWorkflow, resolveStepContent } = useStepResolver();
  const wf = session.workflow;
  const forStep = !!wf && !isWorkflowFinished(session);
  const stepIndex = wf?.stepIndex ?? 0;
  const goal = forStep ? (wf!.stepGoal?.stepIndex === stepIndex ? wf!.stepGoal : undefined) : session.goal;
  // An inline snapshot wins, as in SessionView: it is not in any library here.
  const def = wf ? (wf.def ?? findWorkflow(wf.workflowId)) : undefined;
  const step = forStep ? def?.steps[stepIndex] : undefined;
  const stepName = step ? resolveStepContent(step)?.name : undefined;

  const [condition, setCondition] = useState('');
  const [maxTurns, setMaxTurns] = useState<number>(GOAL_DEFAULT_MAX_TURNS);
  const [onMet, setOnMet] = useState<GoalOnMet>('advance');

  // Re-seeded on every open, so an edit starts from the goal as it stands now.
  useEffect(() => {
    if (!opened) return;
    setCondition(goal?.condition ?? '');
    setMaxTurns(goal?.maxTurns ?? GOAL_DEFAULT_MAX_TURNS);
    setOnMet(forStep ? (wf!.stepGoal?.stepIndex === stepIndex ? wf!.stepGoal.onMet : 'advance') : 'advance');
    // Only on open: a goal update mid-edit must not overwrite what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const trimmed = condition.trim();
  const resuming = goal && goal.status !== 'active' && goal.status !== 'evaluating';
  const submit = () => {
    if (!trimmed) return;
    send({
      type: 'setGoal',
      sessionId: session.id,
      condition: trimmed,
      maxTurns: clampGoalMaxTurns(maxTurns),
      ...(forStep ? { onMet } : {}),
    });
    onClose();
  };

  const title = forStep
    ? `Goal for step ${stepIndex + 1}${stepName ? `: ${stepName}` : ''}`
    : goal
      ? 'Edit goal'
      : 'Set a goal';

  return (
    <Modal opened={opened} onClose={onClose} title={title} centered>
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          {forStep
            ? 'After each turn of this step, a small model checks this condition against the reply. Until it is met, the step keeps working — up to the turn limit, then it waits for you. Stop halts it.'
            : 'After each turn, a small model checks this condition against the reply. Until it is met, the agent is prompted to keep going — up to the turn limit. Stop halts it.'}
        </Text>
        <Textarea
          label="Done when"
          placeholder="e.g. all server tests pass and the typecheck is clean"
          autosize
          minRows={3}
          maxRows={10}
          value={condition}
          onChange={(e) => setCondition(e.currentTarget.value)}
          data-autofocus
        />
        <NumberInput
          label="Max auto-continue turns"
          min={1}
          max={GOAL_MAX_TURNS_LIMIT}
          clampBehavior="strict"
          allowDecimal={false}
          value={maxTurns}
          onChange={(v) => setMaxTurns(typeof v === 'number' ? v : GOAL_DEFAULT_MAX_TURNS)}
        />
        {forStep && (
          <div>
            <Text size="sm" fw={500} mb={4}>
              When it is met
            </Text>
            <SegmentedControl
              size="xs"
              aria-label="When the goal is met"
              data={GOAL_ON_MET_DATA}
              value={onMet}
              onChange={(v) => setOnMet(v as GoalOnMet)}
            />
          </div>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!trimmed} onClick={submit}>
            {resuming ? 'Resume goal' : goal ? 'Update goal' : 'Set goal'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
