import { Text } from '@mantine/core';
import type { ComboboxItem, SelectProps } from '@mantine/core';
import type { ModelOption } from '@lines/shared';

interface ModelItem extends ComboboxItem {
  description?: string;
}

/** Widen the dropdown for narrow model Selects without widening the input. */
export const modelComboboxProps = { width: 240, position: 'bottom-start' as const };

export function modelSelectData(models: ModelOption[], ensureId?: string): ModelItem[] {
  const data: ModelItem[] = models.map((m) => ({ value: m.id, label: m.label, description: m.description }));
  if (ensureId && !models.some((m) => m.id === ensureId)) {
    data.push({ value: ensureId, label: ensureId, description: 'No longer available', disabled: true });
  }
  return data;
}

export const renderModelOption: SelectProps['renderOption'] = ({ option }) => (
  <div>
    <Text size="sm">{option.label}</Text>
    {(option as ModelItem).description && (
      <Text size="xs" c="dimmed">
        {(option as ModelItem).description}
      </Text>
    )}
  </div>
);
