import { useState } from 'react';
import {
  Collapse,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import type { ModelOption, PermissionMode, ReasoningEffort, StepContent } from '@lines/shared';
import { providerForModel, providerSwitchNeedsFreshStart } from '@lines/shared';
import {
  AUTO_EFFORT,
  effortSelectData,
  modelComboboxProps,
  modelSelectData,
  renderModelOption,
  renderOptionWithDescription,
  STEP_EFFORTS,
} from '../../lib/modelSelect';
import { permissionModeSelectData, renderPermissionModeOption } from '../../lib/permissionModes';
import { emptyRoutingRule, RoutingRuleFields } from '../RoutingRuleFields';
import type { StepErrors } from './useWorkflowDraft';
import styles from './workflow.module.css';

// The words for a step's place in a run, shared by the editor's outline, the
// library's settings and the run-time stepper, so all three say the same thing.

/** What happens when a step finishes. The last step finishes the workflow instead. */
export function gateLabel(autoAdvance: boolean, last = false): string {
  if (autoAdvance) return last ? 'Finish automatically' : 'Continue automatically';
  return 'Wait for approval';
}

export const GATE_HINTS = {
  wait: 'Parks when it finishes: approve to move on, or reply to keep iterating.',
  auto: 'Moves on as soon as it finishes, without asking.',
} as const;

/** How a step starts: in the running conversation, or in a clean session. */
export function startLabel(freshStart: boolean): string {
  return freshStart ? 'Fresh start' : 'Same conversation';
}

export const START_HINTS = {
  same: 'Continues the conversation the step before it ran in.',
  fresh: "A clean session, handed the previous step's output and the diff instead of the conversation.",
} as const;

/** Does a step on `model`, entered after one on `previousModel`, have to start fresh? */
export function crossesProvider(previousModel: string | undefined, model: string): boolean {
  return (
    previousModel !== undefined &&
    providerSwitchNeedsFreshStart(providerForModel(previousModel), providerForModel(model))
  );
}

export function modelLabel(models: ModelOption[], id: string): string {
  return models.find((m) => m.id === id)?.label ?? id;
}

/** A step's effort as its picker labels it; absent reads as Auto. */
export function effortLabel(effort?: ReasoningEffort | null): string {
  const value = effort ?? AUTO_EFFORT;
  return effortSelectData(STEP_EFFORTS, value).find((e) => e.value === value)?.label ?? value;
}

/**
 * A step's settings, shared by the workflow editor's step pane and the step
 * library — two hand-kept copies of this drifted, and the library's save lost
 * fields the editor had.
 *
 * `flow="inline"` adds the "In a workflow" group (gate and start mode). The
 * library needs it, having no neighbouring steps to put those on; the editor
 * passes `"none"` because its outline carries them, between the steps.
 */
export function StepSettings({
  value,
  onPatch,
  readOnly,
  models,
  errors,
  previousModel,
  flow,
}: {
  value: StepContent;
  onPatch: (patch: Partial<StepContent>) => void;
  /** Pinned or someone else's content: values stay legible, nothing changes. */
  readOnly: boolean;
  models: ModelOption[];
  errors?: Pick<StepErrors, 'outputName' | 'routing'>;
  /** The model the step before this one runs on; undefined when there is none
   *  known (step 0, whose predecessor is the session, or a library step). */
  previousModel?: string;
  flow: 'inline' | 'none';
}) {
  const forcedFresh = crossesProvider(previousModel, value.model);
  const [advancedOpen, setAdvancedOpen] = useState(value.routing !== undefined || !!errors?.routing);
  // An error raised after mount (a failed save) has to show even if the
  // disclosure was closed, or the message sits behind it.
  const showAdvanced = advancedOpen || !!errors?.routing;
  const output = (value.outputName ?? '').trim();

  return (
    <Stack gap={14}>
      <Group align="flex-start" gap={24} wrap="wrap">
        <div>
          <div className={styles.label}>Runs on</div>
          <Group gap="sm" align="flex-start" wrap="wrap">
            <Select
              label="Model"
              size="xs"
              w={170}
              comboboxProps={modelComboboxProps}
              // Any provider. A library step has no predecessor to cross, so the
              // fresh-start rule applies where it is knowable: on the step's
              // position in a workflow.
              data={modelSelectData(models, value.model)}
              renderOption={renderModelOption}
              value={value.model}
              readOnly={readOnly}
              allowDeselect={false}
              // Picking a model that changes provider turns Fresh start on in the
              // same patch. The alternative — letting it save and refusing at run
              // time — is the same outcome discovered several minutes later.
              onChange={(v) =>
                v && onPatch({ model: v, ...(crossesProvider(previousModel, v) ? { freshStart: true } : {}) })
              }
            />
            <Select
              label="Effort"
              size="xs"
              w={110}
              comboboxProps={modelComboboxProps}
              // Claude's list, whichever model the step names: a step carrying an
              // OpenAI model is rejected by validation, so codex's `minimal` is
              // not a level a step can ever run at.
              data={effortSelectData(STEP_EFFORTS, value.reasoningEffort)}
              renderOption={renderOptionWithDescription}
              value={value.reasoningEffort ?? AUTO_EFFORT}
              readOnly={readOnly}
              allowDeselect={false}
              onChange={(v) =>
                v && onPatch({ reasoningEffort: v === AUTO_EFFORT ? undefined : (v as ReasoningEffort) })
              }
            />
            <Select
              label="Permission"
              size="xs"
              w={130}
              comboboxProps={modelComboboxProps}
              data={permissionModeSelectData(value.permissionMode)}
              renderOption={renderPermissionModeOption}
              value={value.permissionMode}
              readOnly={readOnly}
              allowDeselect={false}
              onChange={(v) => v && onPatch({ permissionMode: v as PermissionMode })}
            />
          </Group>
        </div>
        <div>
          <div className={styles.label}>Output</div>
          <TextInput
            label="Name"
            size="xs"
            w={200}
            placeholder={readOnly ? 'Not published' : 'e.g. plan'}
            description={readOnly && !output ? undefined : `Later steps can use {outputs.${output || '<name>'}}`}
            inputWrapperOrder={['label', 'input', 'description', 'error']}
            value={value.outputName ?? ''}
            readOnly={readOnly}
            error={errors?.outputName}
            onChange={(e) => onPatch({ outputName: e.currentTarget.value })}
          />
        </div>
      </Group>

      {flow === 'inline' && (
        <div>
          <div className={styles.label}>In a workflow</div>
          <Group align="flex-start" gap={28} wrap="wrap">
            <div>
              <Text size="xs" mb={4}>
                When it finishes
              </Text>
              <SegmentedControl
                size="xs"
                aria-label="When it finishes"
                readOnly={readOnly}
                value={value.autoAdvance ? 'auto' : 'wait'}
                data={[
                  { value: 'wait', label: gateLabel(false) },
                  { value: 'auto', label: gateLabel(true) },
                ]}
                onChange={(v) => onPatch({ autoAdvance: v === 'auto' })}
              />
              <Text size="xs" c="dimmed" mt={4} maw={320}>
                {value.autoAdvance ? GATE_HINTS.auto : GATE_HINTS.wait}
              </Text>
            </div>
            <div>
              <Text size="xs" mb={4}>
                How it starts
              </Text>
              <SegmentedControl
                size="xs"
                aria-label="How it starts"
                // Locked rather than merely defaulted: switching it back off
                // would save a step the runner then refuses to start.
                readOnly={readOnly || forcedFresh}
                value={value.freshStart || forcedFresh ? 'fresh' : 'same'}
                data={[
                  { value: 'same', label: startLabel(false) },
                  { value: 'fresh', label: startLabel(true) },
                ]}
                onChange={(v) => onPatch({ freshStart: v === 'fresh' })}
              />
              <Text size="xs" c="dimmed" mt={4} maw={320}>
                {forcedFresh
                  ? 'Required: this step changes provider, and a conversation cannot move between providers.'
                  : value.freshStart
                    ? START_HINTS.fresh
                    : START_HINTS.same}
              </Text>
            </div>
          </Group>
        </div>
      )}

      <div>
        <UnstyledButton
          className={styles.disclosure}
          aria-expanded={showAdvanced}
          onClick={() => setAdvancedOpen((o) => !o)}
        >
          <IconChevronRight
            size={12}
            style={{ transform: showAdvanced ? 'rotate(90deg)' : undefined, transition: 'transform 150ms' }}
          />
          <span className={styles.label}>Advanced</span>
          {!showAdvanced && (
            <Text size="xs" c="dimmed">
              {value.routing ? 'Own routing rule' : 'Global routing rule'}
            </Text>
          )}
        </UnstyledButton>
        <Collapse expanded={showAdvanced}>
          <Stack gap={8} pt={8} maw={560}>
            <Switch
              size="xs"
              label="Own routing rule"
              description="Override the global smart-routing rule while this step runs"
              checked={value.routing !== undefined}
              disabled={readOnly}
              onChange={(e) => onPatch({ routing: e.currentTarget.checked ? emptyRoutingRule() : undefined })}
            />
            {value.routing && (
              <RoutingRuleFields
                provider={providerForModel(value.model)}
                models={models}
                value={value.routing}
                disabled={readOnly}
                onChange={(routing) => onPatch({ routing })}
              />
            )}
            {errors?.routing && (
              <Text size="xs" c="red">
                {errors.routing}
              </Text>
            )}
          </Stack>
        </Collapse>
      </div>
    </Stack>
  );
}
