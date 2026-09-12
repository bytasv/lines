import { Text } from '@mantine/core';
import type { ComboboxItem, SelectProps } from '@mantine/core';
import type { ModelOption, ModelProvider } from '@lines/shared';

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
