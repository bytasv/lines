import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Anchor,
  Button,
  Group,
  Modal,
  NumberInput,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { IconTarget } from '@tabler/icons-react';
import type { GoalOnMet, StepGoalSpec, WorkflowDef, WorkflowStepOverride } from '@lines/shared';
import { GOAL_DEFAULT_MAX_TURNS, GOAL_MAX_TURNS_LIMIT } from '@lines/shared';
import { useStore } from '../../store';
import {
  AUTO_EFFORT,
  STEP_EFFORTS,
  effortSelectData,
  modelComboboxProps,
  modelSelectData,
  renderModelOption,
  renderOptionWithDescription,
} from '../../lib/modelSelect';
import { useStepResolver } from '../../lib/useStepResolver';
import {
  type StepRowChoice,
  seedStepRows,
  stepOverridesFromRows,
  stepRowDefaults,
} from '../../lib/stepOverrides';

/**
 * The per-step model/effort rows of a run picker, shared by this modal and the
 * sidebar's Single run window so the two cannot drift. `workflow` may be absent
 * (a bare run picks no steps). Callers decide when to `reseed`.
 */
export function useStepOverrideRows(
  workflow: WorkflowDef | null | undefined,
  initialOverrides?: (WorkflowStepOverride | null)[],
  lockedIndices?: number[],
) {
  const { resolveStepContent } = useStepResolver();
  const contents = (workflow?.steps ?? []).map((step) => resolveStepContent(step));
  const defaults = () => stepRowDefaults(contents);
  const seeded = () => seedStepRows(defaults(), initialOverrides);

  const [rows, setRows] = useState<StepRowChoice[]>(seeded);
  const locked = new Set(lockedIndices ?? []);

  const patch = (i: number, next: Partial<StepRowChoice>) =>
    setRows((list) => list.map((r, n) => (n === i ? { ...r, ...next } : r)));

  const reset = () =>
    setRows((list) => {
      const base = defaults();
      return list.map((r, i) => (locked.has(i) ? r : base[i]!));
    });

  return {
    contents,
    rows,
    locked,
    patch,
    reset,
    reseed: () => setRows(seeded()),
    overrides: () => stepOverridesFromRows(rows, defaults(), locked, initialOverrides),
  };
}

export type StepOverrideRowsState = ReturnType<typeof useStepOverrideRows>;

/** The "When met" choice shared by the run rows and the goal modal. */
export const GOAL_ON_MET_DATA: { value: GoalOnMet; label: string }[] = [
  { value: 'advance', label: 'Continue to next step' },
  { value: 'wait', label: 'Wait for approval' },
];

/** A step's planned goal: condition, turn cap, and what happens when it is met. */
function StepGoalEditor({
  index,
  goal,
  disabled,
  onChange,
}: {
  index: number;
  goal: StepGoalSpec;
  disabled: boolean;
  onChange: (goal: StepGoalSpec) => void;
}) {
  return (
    <Stack gap={6} pl={24}>
      <Textarea
        size="xs"
        aria-label={`Goal for step ${index + 1}`}
        placeholder="Done when… e.g. the feature works end to end and its tests pass"
        autosize
        minRows={2}
        maxRows={6}
        disabled={disabled}
        value={goal.condition}
        onChange={(e) => onChange({ ...goal, condition: e.currentTarget.value })}
      />
      <Group gap="xs" wrap="wrap">
        <NumberInput
          size="xs"
          w={110}
          aria-label={`Max goal turns for step ${index + 1}`}
          min={1}
          max={GOAL_MAX_TURNS_LIMIT}
          clampBehavior="strict"
          allowDecimal={false}
          disabled={disabled}
          value={goal.maxTurns}
          onChange={(v) => onChange({ ...goal, maxTurns: typeof v === 'number' ? v : GOAL_DEFAULT_MAX_TURNS })}
          suffix=" turns"
        />
        <SegmentedControl
          size="xs"
          aria-label={`When the goal of step ${index + 1} is met`}
          disabled={disabled}
          data={GOAL_ON_MET_DATA}
          value={goal.onMet}
          onChange={(v) => onChange({ ...goal, onMet: v as GoalOnMet })}
        />
      </Group>
    </Stack>
  );
}

/** One model + effort row per step; locked and unresolved steps render disabled. */
export function StepOverrideRows({ state }: { state: StepOverrideRowsState }) {
  const models = useStore((s) => s.models);
  const { contents, rows, locked, patch } = state;
  /** Opening a row's goal seeds an empty one; closing drops it. */
  const toggleGoal = (i: number, open: boolean) =>
    patch(i, { goal: open ? { condition: '', maxTurns: GOAL_DEFAULT_MAX_TURNS, onMet: 'advance' } : undefined });
  return (
    <ScrollArea.Autosize mah={360} type="auto">
      <Stack gap={6} pr="xs">
        {contents.map((content, i) => {
          const row = rows[i] ?? { model: '', effort: AUTO_EFFORT };
          const disabled = locked.has(i) || !content;
          const showGoal = !!row.goal;
          return (
            <Stack key={i} gap={4}>
              <Group gap="xs" wrap="nowrap">
                <Text size="xs" c="dimmed" w={16}>
                  {i + 1}
                </Text>
                <Text
                  size="sm"
                  truncate
                  c={disabled ? 'dimmed' : undefined}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {content?.name ?? 'Pinned step'}
                </Text>
                <Select
                  w={170}
                  size="xs"
                  aria-label={`Model for step ${i + 1}`}
                  comboboxProps={modelComboboxProps}
                  // Claude only: a step that changed provider here could not carry
                  // the run's conversation, and its routing rule is Claude's.
                  data={modelSelectData(models, row.model || undefined, { providers: ['anthropic'] })}
                  renderOption={renderModelOption}
                  value={row.model || null}
                  disabled={disabled}
                  allowDeselect={false}
                  onChange={(v) => v && patch(i, { model: v })}
                />
                <Select
                  w={120}
                  size="xs"
                  aria-label={`Reasoning effort for step ${i + 1}`}
                  comboboxProps={modelComboboxProps}
                  data={effortSelectData(STEP_EFFORTS, row.effort)}
                  renderOption={renderOptionWithDescription}
                  value={row.effort}
                  disabled={disabled}
                  allowDeselect={false}
                  onChange={(v) => v && patch(i, { effort: v })}
                />
                <Tooltip label={showGoal ? 'Remove goal' : 'Add a goal — the step keeps working until it is met'}>
                  <ActionIcon
                    size="sm"
                    variant={showGoal ? 'light' : 'subtle'}
                    color={showGoal ? undefined : 'gray'}
                    aria-label={`Goal for step ${i + 1}`}
                    disabled={disabled}
                    onClick={() => toggleGoal(i, !showGoal)}
                  >
                    <IconTarget size={14} />
                  </ActionIcon>
                </Tooltip>
              </Group>
              {row.goal && (
                <StepGoalEditor
                  index={i}
                  goal={row.goal}
                  disabled={disabled}
                  onChange={(goal) => patch(i, { goal })}
                />
              )}
            </Stack>
          );
        })}
      </Stack>
    </ScrollArea.Autosize>
  );
}

/**
 * Pick the model and reasoning effort each step of one run uses, without
 * touching the workflow itself. Used mid-run from the stepper, where steps that
 * already ran or are running are shown but locked. (Launch-time picks go through
 * the sidebar's Single run window, which shares these rows.)
 *
 * Every row defaults to the step's own values; only rows that differ come back
 * as overrides, so an untouched modal changes nothing.
 */
export function WorkflowRunModal({
  opened,
  workflow,
  initialOverrides,
  lockedIndices,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  opened: boolean;
  workflow: WorkflowDef;
  initialOverrides?: (WorkflowStepOverride | null)[];
  /** Steps shown but not editable — anything no longer pending mid-run. */
  lockedIndices?: number[];
  confirmLabel: string;
  onConfirm: (overrides: (WorkflowStepOverride | null)[]) => void;
  onClose: () => void;
}) {
  const rows = useStepOverrideRows(workflow, initialOverrides, lockedIndices);

  // Re-seed on each open: the run (and its overrides) may have moved since.
  useEffect(() => {
    if (opened) rows.reseed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={workflow.name}
      size="lg"
      centered
      transitionProps={{ transition: 'fade' }}
    >
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          Model, effort and goals for this run only — the workflow’s steps stay as they are.
        </Text>
        <StepOverrideRows state={rows} />
        <Group justify="space-between" mt="xs">
          <Anchor component="button" type="button" size="xs" c="dimmed" onClick={rows.reset}>
            Reset to workflow defaults
          </Anchor>
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                onConfirm(rows.overrides());
                onClose();
              }}
            >
              {confirmLabel}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
