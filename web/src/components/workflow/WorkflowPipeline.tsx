import { Box, Group, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import type { Draft, ValidationResult } from './useWorkflowDraft';

export function WorkflowPipeline({
  draft,
  collapsed,
  validation,
  submitAttempted,
  readOnly,
  onSelectStep,
  onAddStep,
}: {
  draft: Draft;
  collapsed: Set<string>;
  validation: ValidationResult | null;
  submitAttempted: boolean;
  readOnly: boolean;
  onSelectStep: (uid: string) => void;
  onAddStep: () => void;
}) {
  return (
    <Group gap="sm" wrap="nowrap" align="center" px="xs">
      {draft.steps.map((step, i) => {
        const expanded = !collapsed.has(step._uid);
        const invalid = submitAttempted && !!validation?.steps[step._uid];
        return (
          <Group
            key={step._uid}
            gap={8}
            wrap="nowrap"
            style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
            onClick={() => onSelectStep(step._uid)}
          >
            <ThemeIcon
              size={22}
              radius="xl"
              variant={expanded ? 'filled' : 'default'}
              color={invalid ? 'red' : undefined}
            >
              <Text fz={11}>{i + 1}</Text>
            </ThemeIcon>
            <Text size="xs" fw={expanded ? 600 : 500} c={invalid ? 'red' : undefined} truncate>
              {step.name || 'Untitled'}
            </Text>
            {i < draft.steps.length - 1 && (
              <Box
                style={{
                  flex: 1,
                  minWidth: 12,
                  height: 3,
                  borderRadius: 2,
                  background: 'var(--mantine-color-default-hover)',
                }}
              />
            )}
          </Group>
        );
      })}
      {!readOnly && (
        <Tooltip label="Add step">
          <ThemeIcon
            size={22}
            radius="xl"
            variant="default"
            style={{ cursor: 'pointer', flexShrink: 0 }}
            onClick={onAddStep}
          >
            <IconPlus size={13} />
          </ThemeIcon>
        </Tooltip>
      )}
    </Group>
  );
}
