import { ActionIcon, Badge, Group, Paper, Text, Tooltip } from '@mantine/core';
import { IconPencil, IconPlayerPlay, IconTarget, IconX } from '@tabler/icons-react';
import type { GoalState } from '@lines/shared';

/** The chip's status label and colour for a goal. */
export function goalStatusLabel(goal: GoalState): { label: string; color: string } {
  switch (goal.status) {
    case 'active':
      return { label: 'Active', color: 'blue' };
    case 'evaluating':
      return { label: 'Checking…', color: 'blue' };
    case 'met':
      return { label: 'Met', color: 'teal' };
    case 'stopped':
      return { label: 'Stopped', color: 'gray' };
    case 'paused':
      return {
        label:
          goal.pauseReason === 'cap'
            ? 'Paused · turn limit'
            : goal.pauseReason === 'turn-failed'
              ? 'Paused · turn failed'
              : goal.pauseReason === 'judge-failed'
                ? 'Paused · check failed'
                : goal.pauseReason === 'restart'
                  ? 'Paused · restarted'
                  : 'Paused',
        color: 'orange',
      };
  }
}

/** The session goal above the composer: condition, progress, status, and its actions. */
export function GoalChip({
  goal,
  stepIndex,
  canEdit,
  onEdit,
  onClear,
}: {
  goal: GoalState;
  /** Set when the goal is a workflow step's. */
  stepIndex?: number;
  canEdit: boolean;
  onEdit: () => void;
  onClear: () => void;
}) {
  const status = goalStatusLabel(goal);
  const live = goal.status === 'active' || goal.status === 'evaluating';
  const reason = goal.lastVerdict?.reason;
  return (
    <Paper withBorder radius="md" px="xs" py={4} mx={6} mb={6}>
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
          <IconTarget size={14} style={{ flexShrink: 0 }} />
          {stepIndex !== undefined && (
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
              Step {stepIndex + 1}
            </Text>
          )}
          <Tooltip label={reason ? `${goal.condition}\n\nLast check: ${reason}` : goal.condition} multiline maw={360}>
            <Text size="xs" truncate style={{ minWidth: 0 }}>
              {goal.condition}
            </Text>
          </Tooltip>
        </Group>
        <Group gap={6} wrap="nowrap">
          <Text size="xs" c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {goal.turnsUsed}/{goal.maxTurns}
          </Text>
          <Badge size="xs" variant="light" color={status.color} style={{ textTransform: 'none' }}>
            {status.label}
          </Badge>
          <Tooltip label={live ? 'Edit goal' : 'Resume or edit goal'}>
            <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Edit goal" disabled={!canEdit} onClick={onEdit}>
              {live || goal.status === 'met' ? <IconPencil size={14} /> : <IconPlayerPlay size={14} />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Clear goal">
            <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Clear goal" disabled={!canEdit} onClick={onClear}>
              <IconX size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
    </Paper>
  );
}
