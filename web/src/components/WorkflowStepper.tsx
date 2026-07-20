import { useState } from 'react';
import { Box, Button, Group, Loader, Paper, Text, Textarea, ThemeIcon } from '@mantine/core';
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
      color={status === 'waiting-approval' ? 'orange' : undefined}
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
  const [feedback, setFeedback] = useState('');
  const [showRetry, setShowRetry] = useState(false);

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
                    background: 'var(--mantine-color-grape-5)',
                  }}
                />
              </Box>
            </Group>
          );
        })}
      </Group>
      {waiting && (
        <Paper withBorder radius="md" p="sm" mt="xs" style={{ borderColor: 'var(--mantine-color-orange-6)' }}>
          <Group justify="space-between" wrap="wrap" gap="xs">
            <Text size="sm" fw={600}>
              “{workflow.steps[state.stepIndex]?.name}” finished — approve to continue?
            </Text>
            <Group gap="xs">
              <Button size="xs" color="teal" onClick={() => send({ type: 'workflowApprove', sessionId: session.id })}>
                Approve → next step
              </Button>
              <Button size="xs" variant="light" color="orange" onClick={() => setShowRetry((v) => !v)}>
                Retry with feedback
              </Button>
            </Group>
          </Group>
          {showRetry && (
            <Group mt="xs" gap="xs" align="flex-end">
              <Textarea
                style={{ flex: 1 }}
                autosize
                minRows={1}
                maxRows={4}
                placeholder="What should change?"
                value={feedback}
                onChange={(e) => setFeedback(e.currentTarget.value)}
              />
              <Button
                size="xs"
                disabled={!feedback.trim()}
                onClick={() => {
                  send({ type: 'workflowRetry', sessionId: session.id, feedback: feedback.trim() });
                  setFeedback('');
                  setShowRetry(false);
                }}
              >
                Retry step
              </Button>
            </Group>
          )}
        </Paper>
      )}
    </Paper>
  );
}
