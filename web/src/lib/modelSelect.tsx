import { Text } from '@mantine/core';
import type { ComboboxItem, SelectProps } from '@mantine/core';
import type { ModelOption, ModelProvider, ReasoningEffort } from '@lines/shared';
import { capabilitiesFor } from '@lines/shared';

/** Any Select item that renders a dimmed second line under its label. */
export interface DescribedItem extends ComboboxItem {
  description?: string;
}

/** Widen the dropdown for narrow described Selects without widening the input. */
export const modelComboboxProps = { width: 240, position: 'bottom-start' as const };

export interface ModelSelectOptions {
  /**
   * Which providers this call site may offer. Absent = all of them.
   *
   * A filter rather than a per-component `models.filter(...)`, because this module
   * is the single entry point every model Select goes through — a second place
   * that decides what a picker may show is how the four call sites drift.
   */
  providers?: ModelProvider[];
  /**
   * Providers to render present but disabled, with the reason as the option's
   * description. For "you could use this, once you connect an account" — hiding
   * it would leave no clue the model exists.
   */
  unavailable?: Partial<Record<ModelProvider, string>>;
}

/** A model's provider, with the same "absent means anthropic" default the type has. */
function providerOf(model: ModelOption): ModelProvider {
  return model.provider ?? 'anthropic';
}

export function modelSelectData(
  models: ModelOption[],
  ensureId?: string,
  opts: ModelSelectOptions = {},
): DescribedItem[] {
  const allowed = opts.providers;
  const data: DescribedItem[] = models
    .filter((m) => !allowed || allowed.includes(providerOf(m)))
    .map((m) => {
      const blocked = opts.unavailable?.[providerOf(m)];
      return {
        value: m.id,
        label: m.label,
        description: blocked ?? m.description,
        ...(blocked ? { disabled: true } : {}),
      };
    });
  // The stored id, whatever it is: an unknown, filtered-out or retired model must
  // render as a disabled row rather than leave the Select blank.
  if (ensureId && !data.some((m) => m.value === ensureId)) {
    data.push({ value: ensureId, label: ensureId, description: 'No longer available', disabled: true });
  }
  return data;
}

/**
 * The "no choice made" row of an effort Select. A real option rather than an
 * empty value, because Mantine renders an unmatched value as a blank input — and
 * "unset" is the default every session starts in, so it has to read as a choice.
 */
export const AUTO_EFFORT = 'auto';

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/**
 * Effort options for one engine, weakest first, led by Auto.
 *
 * Takes the provider's own list (`ProviderCapabilities.reasoningEfforts`) rather
 * than a vendor's vocabulary spelt out at the call site — same reason
 * {@link modelSelectData} takes the model list: this module is the single entry
 * point every described Select goes through.
 */
export function effortSelectData(
  efforts: readonly ReasoningEffort[],
  ensureValue?: string,
): DescribedItem[] {
  const data: DescribedItem[] = [
    { value: AUTO_EFFORT, label: 'Auto', description: 'The model’s own default' },
    ...efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] })),
  ];
  // Same trick modelSelectData uses: a stored level this provider no longer
  // offers renders as a disabled row instead of blanking the Select.
  if (ensureValue && !data.some((e) => e.value === ensureValue)) {
    data.push({ value: ensureValue, label: ensureValue, description: 'Not available here', disabled: true });
  }
  return data;
}

/** What a workflow step may be set to: a step runs on Claude only (an OpenAI
 *  model on a step is a validation error), so codex's `minimal` is unreachable. */
export const STEP_EFFORTS = capabilitiesFor('anthropic').reasoningEfforts;

export const renderOptionWithDescription: SelectProps['renderOption'] = ({ option }) => (
  <div>
    <Text size="sm">{option.label}</Text>
    {(option as DescribedItem).description && (
      <Text size="xs" c="dimmed">
        {(option as DescribedItem).description}
      </Text>
    )}
  </div>
);

export const renderModelOption = renderOptionWithDescription;
