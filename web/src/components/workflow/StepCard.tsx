import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Collapse,
  Group,
  Menu,
  Popover,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconChevronDown,
  IconCopy,
  IconDots,
  IconGripVertical,
  IconLock,
  IconPencil,
  IconTrash,
  IconWorld,
} from '@tabler/icons-react';
import type { DraggableProvidedDragHandleProps } from '@hello-pangea/dnd';
import type { PermissionMode, ModelOption, StepContent, StepDef } from '@claude-ui/shared';
import type { DraftStep, StepErrors } from './useWorkflowDraft';
import { MODE_OPTIONS } from './useWorkflowDraft';
import { PromptEditor } from './PromptEditor';
import { modelComboboxProps, modelSelectData, renderModelOption } from '../../lib/modelSelect';
import styles from './workflow.module.css';

const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(' ');

const FIELD_LABELS: Record<keyof StepContent, string> = {
  name: 'Name',
  promptTemplate: 'Prompt',
  model: 'Model',
  permissionMode: 'Permission',
  autoAdvance: 'Auto-advance',
  freshStart: 'Fresh start',
  outputName: 'Output name',
};

function changedFields(a: StepContent, b: StepContent): (keyof StepContent)[] {
  return (Object.keys(FIELD_LABELS) as (keyof StepContent)[]).filter((k) => String(a[k]) !== String(b[k]));
}

function UpdatePopover({ pinned, head, onUpdate }: { pinned: StepContent; head: StepDef; onUpdate: () => void }) {
  const fields = changedFields(pinned, head);
  return (
    <Popover width={360} position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <Tooltip label={`Update available — v${head.version}`}>
          <ActionIcon size="sm" variant="light" color="yellow" radius="xl">
            <IconAlertTriangle size={14} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={10}>
          <Text size="xs" fw={600}>
            {head.ownerName ?? 'The owner'} published v{head.version}
          </Text>
          {fields.length === 0 ? (
            <Text size="xs" c="dimmed">No field changes.</Text>
          ) : (
            <ScrollArea.Autosize mah={280} type="auto">
              <Stack gap={10}>
                {fields.map((f) => (
                  <Stack key={f} gap={2}>
                    <Text size="xs" fw={600} c="dimmed">{FIELD_LABELS[f]}</Text>
                    <Text size="xs" c="red" style={{ whiteSpace: 'pre-wrap' }}>- {String(pinned[f]) || '(empty)'}</Text>
                    <Text size="xs" c="teal" style={{ whiteSpace: 'pre-wrap' }}>+ {String(head[f]) || '(empty)'}</Text>
                  </Stack>
                ))}
              </Stack>
            </ScrollArea.Autosize>
          )}
          <Button size="xs" onClick={onUpdate}>Update to v{head.version}</Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

export function StepCard({
  step,
  index,
  collapsed,
  errors,
  readOnly,
  models,
  ownsRef,
  updateDef,
  dragHandleProps,
  onPatch,
  onToggle,
  onExpand,
  onDuplicate,
  onRemove,
  onPublish,
  onEdit,
  onUpdateToLatest,
  availableOutputs,
}: {
  step: DraftStep;
  index: number;
  /** Output names published by earlier steps — offered as {outputs.<name>} tokens. */
  availableOutputs: string[];
  collapsed: boolean;
  errors?: StepErrors;
  readOnly: boolean;
  models: ModelOption[];
  ownsRef: boolean;
  updateDef?: StepDef;
  dragHandleProps?: DraggableProvidedDragHandleProps | null;
  onPatch: (patch: Partial<StepContent>) => void;
  onToggle: () => void;
  onExpand: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onPublish: () => void;
  onEdit: () => void;
  onUpdateToLatest: () => void;
}) {
  const isRef = !!step.ref;
  const contentReadOnly = readOnly || isRef;
  const modeLabel = MODE_OPTIONS.find((m) => m.value === step.permissionMode)?.label ?? step.permissionMode;
  const modelLabel = models.find((m) => m.id === step.model)?.label ?? step.model;
  const invalid = !!errors;

  return (
    <Box
      data-step-uid={step._uid}
      onFocusCapture={collapsed ? onExpand : undefined}
      className={cn(styles.card, !collapsed && styles.cardExpanded, invalid && styles.cardInvalid)}
    >
      {/* Header — click anywhere (except controls) to collapse/expand */}
      <div
        className={styles.header}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('input,button,a,[data-no-toggle]')) return;
          onToggle();
        }}
      >
        {!readOnly && (
          <span {...dragHandleProps} data-no-toggle className={styles.grip} onClick={(e) => e.stopPropagation()}>
            <IconGripVertical size={16} />
          </span>
        )}
        <span className={cn(styles.num, invalid && styles.numInvalid)}>{index + 1}</span>
        <TextInput
          data-no-toggle
          variant="unstyled"
          placeholder="Untitled step"
          style={{ flex: 1, minWidth: 0 }}
          classNames={{ input: styles.titleInput }}
          value={step.name}
          disabled={contentReadOnly}
          onChange={(e) => onPatch({ name: e.currentTarget.value })}
        />

        <Group gap={8} wrap="nowrap" data-no-toggle>
          {isRef && (
            <Badge size="sm" variant="light" color={ownsRef ? 'sandstone' : 'grape'} leftSection={<IconLock size={10} />}>
              {ownsRef ? `v${step.ref!.version}` : `${step.ref!.ownerName ?? 'shared'} · v${step.ref!.version}`}
            </Badge>
          )}
          {isRef && updateDef && <UpdatePopover pinned={step} head={updateDef} onUpdate={onUpdateToLatest} />}
          {collapsed && !isRef && (
            <Group gap={6} wrap="nowrap" visibleFrom="md">
              <Badge size="sm" variant="default">{modelLabel}</Badge>
              <Badge size="sm" variant="default">{modeLabel}</Badge>
              {step.autoAdvance && <Badge size="sm" variant="light" color="sandstone">auto</Badge>}
              {step.freshStart && <Badge size="sm" variant="light" color="grape">fresh</Badge>}
            </Group>
          )}
          {!readOnly && (
            <Menu position="bottom-end" width={190} withinPortal>
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" onClick={(e) => e.stopPropagation()}>
                  <IconDots size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {isRef && ownsRef && (
                  <Menu.Item leftSection={<IconPencil size={14} />} onClick={onEdit}>
                    Edit (new version)
                  </Menu.Item>
                )}
                {!isRef && (
                  <Menu.Item leftSection={<IconWorld size={14} />} onClick={onPublish}>
                    Save as reusable step
                  </Menu.Item>
                )}
                <Menu.Item leftSection={<IconCopy size={14} />} onClick={onDuplicate}>
                  {isRef ? 'Duplicate as editable' : 'Duplicate'}
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={onRemove}>
                  Remove
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          )}
          <ActionIcon variant="subtle" color="gray" onClick={onToggle}>
            <IconChevronDown
              size={16}
              style={{ transform: collapsed ? 'rotate(-90deg)' : undefined, transition: 'transform 150ms' }}
            />
          </ActionIcon>
        </Group>
      </div>

      <Collapse expanded={!collapsed}>
        <div className={styles.body}>
          {errors?.ref && <Text size="xs" c="red" mb={8}>{errors.ref}</Text>}

          <div className={styles.label}>Prompt</div>
          <PromptEditor
            value={step.promptTemplate}
            readOnly={contentReadOnly}
            error={errors?.prompt}
            inputClassName={styles.promptInput}
            freshStart={step.freshStart}
            availableOutputs={availableOutputs}
            onChange={(v) => onPatch({ promptTemplate: v })}
          />

          <div className={styles.settings}>
            <div className={styles.control}>
              <span className={styles.controlLabel}>Model</span>
              <Select
                w={168}
                comboboxProps={modelComboboxProps}
                data={modelSelectData(models)}
                renderOption={renderModelOption}
                value={step.model}
                disabled={contentReadOnly}
                allowDeselect={false}
                classNames={{ input: styles.fieldInput }}
                onChange={(v) => v && onPatch({ model: v })}
              />
            </div>
            <div className={styles.control}>
              <span className={styles.controlLabel}>Permission mode</span>
              <Select
                w={158}
                data={MODE_OPTIONS}
                value={step.permissionMode}
                disabled={contentReadOnly}
                allowDeselect={false}
                classNames={{ input: styles.fieldInput }}
                onChange={(v) => v && onPatch({ permissionMode: v as PermissionMode })}
              />
            </div>
            <Switch
              size="md"
              label="Auto-advance"
              description="Skip approval; run the next step automatically"
              checked={step.autoAdvance}
              disabled={contentReadOnly}
              onChange={(e) => onPatch({ autoAdvance: e.currentTarget.checked })}
            />
            <Switch
              size="md"
              label="Fresh start"
              description="Run in a clean session; seed with prior step's output + diff, not the full conversation"
              checked={step.freshStart}
              disabled={contentReadOnly}
              onChange={(e) => onPatch({ freshStart: e.currentTarget.checked })}
            />
            <div className={styles.control}>
              <span className={styles.controlLabel}>Output name</span>
              <TextInput
                w={168}
                placeholder="e.g. plan"
                value={step.outputName ?? ''}
                disabled={contentReadOnly}
                classNames={{ input: styles.fieldInput }}
                onChange={(e) => onPatch({ outputName: e.currentTarget.value })}
              />
            </div>
          </div>
        </div>
      </Collapse>
    </Box>
  );
}
