import { Box, Button, Center, Group, Loader, Paper, Stack, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { IconCheck, IconCoins } from '@tabler/icons-react';
import type { SessionMeta, WorkflowDef, WorkflowStep, WorkflowStepStatus } from '@lines/shared';
import { isStepRef } from '@lines/shared';
import { formatDuration } from '../lib/format';
import { useStore } from '../store';
import { send } from '../ws';

function StepIcon({ status, index }: { status: WorkflowStepStatus; index: number }) {
  // Fixed width so the title (and the metrics row indented under it) never shifts
  // when a step flips between the 20px loader and the 22px icon.
  return (
    <Center w={22} style={{ flexShrink: 0 }}>
      {status === 'running' ? (
        <Loader size={20} />
      ) : (
        <ThemeIcon size={22} radius="xl" variant={status === 'pending' ? 'default' : 'filled'}>
          {status === 'done' ? <IconCheck size={13} /> : <Text fz={11}>{index + 1}</Text>}
        </ThemeIcon>
      )}
    </Center>
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
      <Group gap="sm" wrap="nowrap" align="stretch">
        {workflow.steps.map((step, i) => {
          const status = state.stepStatuses[i];
          const clickable = status !== 'pending';
          const cost = state.stepCostsUsd?.[i] ?? 0;
          const tokens = state.stepTokens?.[i] ?? 0;
          const durationMs = state.stepDurationsMs?.[i] ?? 0;
          return (
            <Group
              key={i}
              gap={8}
              wrap="nowrap"
              // Title row and metrics row are the same height (18px), so centering the
              // icon against the column lands it exactly on the progress track.
              align="center"
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
              <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                <Text size="xs" lh="18px" fw={i === state.stepIndex ? 600 : 500} truncate>
                  {nameOf(step)}
                </Text>
                {/* Underline doubles as this step's scroll-progress track,
                    filled imperatively by Transcript. */}
                <Box
                  style={{
                    width: '100%',
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
                {/* Always rendered — an invisible placeholder holds the row's height so
                    steps don't jump as metrics arrive. */}
                <Group gap={6} wrap="nowrap" h={18}>
                  {cost === 0 && tokens === 0 && durationMs === 0 && (
                    <Text fz={11} c="dimmed" style={{ visibility: 'hidden' }} aria-hidden>
                      $0.00
                    </Text>
                  )}
                  {cost > 0 && (
                    <Text fz={11} c="dimmed" style={{ flexShrink: 0 }}>
                      ${cost.toFixed(2)}
                    </Text>
                  )}
                  {tokens > 0 && (
                    <Tooltip label={`${tokens.toLocaleString()} tokens spent`} withArrow fz="xs">
                      <Center c="dimmed" style={{ flexShrink: 0 }}>
                        <IconCoins size={11} />
                      </Center>
                    </Tooltip>
                  )}
                  {durationMs > 0 && (
                    <Text fz={11} c="dimmed" style={{ flexShrink: 0 }}>
                      {formatDuration(durationMs)}
                    </Text>
                  )}
                </Group>
              </Stack>
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
