import { ActionIcon, Badge, Collapse, Group, Paper, Select, Switch, Text, TextInput, ThemeIcon, Tooltip } from '@mantine/core';
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconGripVertical,
  IconTrash,
} from '@tabler/icons-react';
import type { DraggableProvidedDragHandleProps } from '@hello-pangea/dnd';
import type { PermissionMode, ModelOption } from '@claude-ui/shared';
import type { DraftStep, StepErrors } from './useWorkflowDraft';
import { MODE_OPTIONS } from './useWorkflowDraft';
import { PromptEditor } from './PromptEditor';

export function StepCard({
  step,
  index,
  collapsed,
  errors,
  readOnly,
  models,
  sampleTask,
  canMoveUp,
  canMoveDown,
  dragHandleProps,
  onPatch,
  onToggle,
  onDuplicate,
  onRemove,
  onMove,
}: {
  step: DraftStep;
  index: number;
  collapsed: boolean;
  errors?: StepErrors;
  readOnly: boolean;
  models: ModelOption[];
  sampleTask: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  dragHandleProps?: DraggableProvidedDragHandleProps | null;
  onPatch: (patch: Partial<DraftStep>) => void;
  onToggle: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const modeLabel = MODE_OPTIONS.find((m) => m.value === step.permissionMode)?.label ?? step.permissionMode;
  const modelLabel = models.find((m) => m.id === step.model)?.label ?? step.model;
  const invalid = !!errors;

  return (
    <Paper
      withBorder
      radius="md"
      p="sm"
      data-step-uid={step._uid}
      style={invalid ? { borderColor: 'var(--mantine-color-red-6)' } : undefined}
    >
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          {!readOnly && (
            <span {...dragHandleProps} style={{ display: 'flex', cursor: 'grab' }}>
              <IconGripVertical size={15} color="var(--mantine-color-dimmed)" />
            </span>
          )}
          <ThemeIcon size={22} radius="xl" variant={invalid ? 'filled' : 'light'} color={invalid ? 'red' : undefined}>
            <Text fz={11}>{index + 1}</Text>
          </ThemeIcon>
          <TextInput
            style={{ flex: 1, minWidth: 0 }}
            value={step.name}
            disabled={readOnly}
            error={errors?.name}
            placeholder="Step name"
            onChange={(e) => onPatch({ name: e.currentTarget.value })}
          />
        </Group>
        <Group gap={4} wrap="nowrap">
          {collapsed && (
            <Group gap={4} wrap="nowrap" visibleFrom="sm">
              <Badge size="xs" variant="light" color="gray">
                {modelLabel}
              </Badge>
              <Badge size="xs" variant="light" color="gray">
                {modeLabel}
              </Badge>
              {step.autoAdvance && (
                <Badge size="xs" variant="light" color="sandstone">
                  auto
                </Badge>
              )}
            </Group>
          )}
          {!readOnly && (
            <>
              <Tooltip label="Move up">
                <ActionIcon size="sm" variant="subtle" disabled={!canMoveUp} onClick={() => onMove(-1)}>
                  <IconArrowUp size={13} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Move down">
                <ActionIcon size="sm" variant="subtle" disabled={!canMoveDown} onClick={() => onMove(1)}>
                  <IconArrowDown size={13} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Duplicate step">
                <ActionIcon size="sm" variant="subtle" onClick={onDuplicate}>
                  <IconCopy size={13} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Remove step">
                <ActionIcon size="sm" variant="subtle" color="red" onClick={onRemove}>
                  <IconTrash size={13} />
                </ActionIcon>
              </Tooltip>
            </>
          )}
          <ActionIcon size="sm" variant="subtle" color="gray" onClick={onToggle}>
            {collapsed ? <IconChevronRight size={15} /> : <IconChevronDown size={15} />}
          </ActionIcon>
        </Group>
      </Group>
      <Collapse expanded={!collapsed}>
        <div style={{ paddingTop: 10 }}>
          <PromptEditor
            value={step.promptTemplate}
            readOnly={readOnly}
            error={errors?.prompt}
            sampleTask={sampleTask}
            onChange={(v) => onPatch({ promptTemplate: v })}
          />
          <Group gap="xs" mt="sm">
            <Select
              w={150}
              label="Model"
              data={models.map((m) => ({ value: m.id, label: m.label }))}
              value={step.model}
              disabled={readOnly}
              allowDeselect={false}
              onChange={(v) => v && onPatch({ model: v })}
            />
            <Select
              w={140}
              label="Permission"
              data={MODE_OPTIONS}
              value={step.permissionMode}
              disabled={readOnly}
              allowDeselect={false}
              onChange={(v) => v && onPatch({ permissionMode: v as PermissionMode })}
            />
            <Switch
              mt="lg"
              size="xs"
              label="Auto-advance"
              checked={step.autoAdvance}
              disabled={readOnly}
              onChange={(e) => onPatch({ autoAdvance: e.currentTarget.checked })}
            />
          </Group>
        </div>
      </Collapse>
    </Paper>
  );
}
