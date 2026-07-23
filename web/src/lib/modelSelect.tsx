import { Text } from '@mantine/core';
import type { ComboboxItem, SelectProps } from '@mantine/core';
import type { ModelOption } from '@claude-ui/shared';

interface ModelItem extends ComboboxItem {
  description?: string;
}

/** Widen the dropdown for narrow model Selects without widening the input. */
export const modelComboboxProps = { width: 240, position: 'bottom-start' as const };

export function modelSelectData(models: ModelOption[]): ModelItem[] {
  return models.map((m) => ({ value: m.id, label: m.label, description: m.description }));
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
