import { Box, Button, Center, Group, Loader, Paper, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { IconCheck, IconCoins } from '@tabler/icons-react';
import type { SessionMeta, WorkflowDef, WorkflowStep, WorkflowStepStatus } from '@claude-ui/shared';
import { isStepRef } from '@claude-ui/shared';
import { formatDuration } from '../lib/format';
import { useStore } from '../store';
import { send } from '../ws';

function StepIcon({ status, index }: { status: WorkflowStepStatus; index: number }) {
  if (status === 'running') return <Loader size={20} />;
  return (
    <ThemeIcon
      size={22}
      radius="xl"
      variant={status === 'pending' ? 'default' : 'filled'}
    >
      {status === 'done' ? <IconCheck size={13} /> : <Text fz={11}>{index + 1}</Text>}
    </ThemeIcon>
  );
}

export function WorkflowStepper({
  session,
  workflow,
}: {
  session: SessionMeta;
  workflow: WorkflowDef;
}) {
  const state = session.workflow!;
  const pinnedSteps = useStore((s) => s.pinnedSteps);
  const sharedSteps = useStore((s) => s.sharedSteps);
  const steps = useStore((s) => s.steps);

  /** Display name for a step, resolving pinned references through the step library. */
  const nameOf = (step: WorkflowStep): string => {
    if (!isStepRef(step)) return step.name;
    const all = [...pinnedSteps, ...steps, ...sharedSteps];
    const found =
      all.find((d) => d.ownerId === step.ownerId && d.id === step.stepId && d.version === step.version) ??
      all.find((d) => d.ownerId === step.ownerId && d.id === step.stepId);
    return found?.name ?? 'Shared step';
  };

  const waiting = state.stepStatuses[state.stepIndex] === 'waiting-approval';

  return (
    <Paper withBorder={false} px="md" pt="xs" pb="xs">
      <Group gap="sm" wrap="nowrap" align="center">
        {workflow.steps.map((step, i) => {
          const status = state.stepStatuses[i];
          const clickable = status !== 'pending';
          return (
            <Group
              key={i}
              gap={8}
              wrap="nowrap"
              style={{ flex: 1, minWidth: 0, cursor: clickable ? 'pointer' : undefined }}
              onClick={
                clickable
                  ? () =>
                      // Jump to the step's start marker in the transcript.
                      document
                        .querySelector(`[data-workflow-step="${i}"]`)
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  : undefined
              }
            >
              <StepIcon status={status} index={i} />
              <Text size="xs" fw={i === state.stepIndex ? 600 : 500} truncate>
                {nameOf(step)}
              </Text>
              {(state.stepCostsUsd?.[i] ?? 0) > 0 && (
                <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                  ${state.stepCostsUsd![i].toFixed(2)}
                </Text>
              )}
              {(state.stepTokens?.[i] ?? 0) > 0 && (
                <Tooltip label={`${state.stepTokens![i].toLocaleString()} tokens spent`} withArrow fz="xs">
                  <Center c="dimmed" style={{ flexShrink: 0 }}>
                    <IconCoins size={11} />
                  </Center>
                </Tooltip>
              )}
              {(state.stepDurationsMs?.[i] ?? 0) > 0 && (
                <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                  {formatDuration(state.stepDurationsMs![i])}
                </Text>
              )}
              {/* Connector doubles as this step's scroll-progress track,
                  filled imperatively by Transcript. */}
              <Box
                style={{
                  flex: 1,
                  minWidth: 12,
                  height: 3,
                  borderRadius: 2,
                  background: 'var(--mantine-color-default-hover)',
                }}
              >
                <Box
                  data-progress-fill
                  style={{
                    height: '100%',
                    width: 0,
                    borderRadius: 2,
                    background: 'var(--mantine-color-sandstone-6)',
                  }}
                />
              </Box>
            </Group>
          );
        })}
      </Group>
      {waiting && (
        <Paper withBorder radius="md" p="sm" mt="xs" style={{ borderColor: 'var(--mantine-color-sandstone-6)' }}>
          <Group justify="space-between" wrap="wrap" gap="xs">
            <Text size="sm" fw={600}>
              “{workflow.steps[state.stepIndex] && nameOf(workflow.steps[state.stepIndex])}” finished — approve to continue, or send a message to keep iterating.
            </Text>
            <Button
              size="xs"
              onClick={() =>
                send({ type: 'workflowApprove', sessionId: session.id, stepIndex: state.stepIndex })
              }
            >
              Approve → next step
            </Button>
          </Group>
        </Paper>
      )}
    </Paper>
  );
}
