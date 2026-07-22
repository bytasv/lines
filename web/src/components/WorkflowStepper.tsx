import { Box, Button, Group, Loader, Paper, Text, ThemeIcon } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import type { SessionMeta, WorkflowDef, WorkflowStepStatus } from '@claude-ui/shared';
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

  const waiting = state.stepStatuses[state.stepIndex] === 'waiting-approval';

  return (
    <Paper withBorder={false} px="md" pt="xs" pb={waiting ? 'xs' : 4}>
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
                {step.name}
              </Text>
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
              “{workflow.steps[state.stepIndex]?.name}” finished — approve to continue, or send a message to keep iterating.
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
