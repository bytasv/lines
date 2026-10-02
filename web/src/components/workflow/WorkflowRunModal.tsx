import { useEffect, useState } from 'react';
import { Anchor, Button, Group, Modal, ScrollArea, Select, Stack, Text } from '@mantine/core';
import type { ReasoningEffort, WorkflowDef, WorkflowStepOverride } from '@lines/shared';
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

/** One row's picks: a model id, and an effort or AUTO_EFFORT. */
interface RowChoice {
  model: string;
  effort: string;
}

/**
 * Pick the model and reasoning effort each step of one run uses, without
 * touching the workflow itself. Used at launch (Cmd/Ctrl+click on a new-session
 * entry) and mid-run from the stepper, where steps that already ran or are
 * running are shown but locked.
 *
 * Every row defaults to the step's own values; only rows that differ come back
 * as overrides, so an untouched modal launches exactly like a plain click.
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
  const models = useStore((s) => s.models);
  const { resolveStepContent } = useStepResolver();
  const contents = workflow.steps.map((step) => resolveStepContent(step));

  /** The step's own values, i.e. what a row resets to. */
  const defaults = (): RowChoice[] =>
    contents.map((c) => ({ model: c?.model ?? '', effort: c?.reasoningEffort ?? AUTO_EFFORT }));

  const seeded = (): RowChoice[] =>
    defaults().map((d, i) => {
      const o = initialOverrides?.[i];
      if (!o) return d;
      return {
        model: o.model ?? d.model,
        effort:
          o.reasoningEffort === undefined ? d.effort : (o.reasoningEffort ?? AUTO_EFFORT),
      };
    });

  const [rows, setRows] = useState<RowChoice[]>(seeded);

  // Re-seed on each open: the run (and its overrides) may have moved since.
  useEffect(() => {
    if (opened) setRows(seeded());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const locked = new Set(lockedIndices ?? []);

  const patch = (i: number, next: Partial<RowChoice>) =>
    setRows((list) => list.map((r, n) => (n === i ? { ...r, ...next } : r)));

  /** Rows that differ from the step's own values; locked rows keep what they had. */
  const overrides = (): (WorkflowStepOverride | null)[] => {
    const base = defaults();
    return rows.map((r, i) => {
      if (locked.has(i)) return initialOverrides?.[i] ?? null;
      const o: WorkflowStepOverride = {};
      if (r.model && r.model !== base[i]!.model) o.model = r.model;
      if (r.effort !== base[i]!.effort) {
        o.reasoningEffort = r.effort === AUTO_EFFORT ? null : (r.effort as ReasoningEffort);
      }
      return Object.keys(o).length ? o : null;
    });
  };

  const reset = () =>
    setRows((list) => {
      const base = defaults();
      return list.map((r, i) => (locked.has(i) ? r : base[i]!));
    });

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
          Model and effort for this run only — the workflow’s steps stay as they are.
        </Text>
        <ScrollArea.Autosize mah={360} type="auto">
          <Stack gap={6} pr="xs">
            {workflow.steps.map((_, i) => {
              const content = contents[i];
              const row = rows[i] ?? { model: '', effort: AUTO_EFFORT };
              const disabled = locked.has(i) || !content;
              return (
                <Group key={i} gap="xs" wrap="nowrap">
                  <Text size="xs" c="dimmed" w={16}>
                    {i + 1}
                  </Text>
                  <Text
                    size="sm"
                    truncate
                    c={disabled ? 'dimmed' : undefined}
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    {content?.name ?? 'Shared step'}
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
                </Group>
              );
            })}
          </Stack>
        </ScrollArea.Autosize>
        <Group justify="space-between" mt="xs">
          <Anchor component="button" type="button" size="xs" c="dimmed" onClick={reset}>
            Reset to workflow defaults
          </Anchor>
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                onConfirm(overrides());
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
