import { MultiSelect, Stack, Textarea } from '@mantine/core';
import type { ModelOption, ModelProvider, ReasoningEffort, RoutingRule } from '@lines/shared';
import { capabilitiesFor } from '@lines/shared';
import { effortSelectData, modelSelectData } from '../lib/modelSelect';

/** An empty rule for a provider, to start editing from. */
export function emptyRoutingRule(): RoutingRule {
  return { rule: '', models: [], efforts: [] };
}

/**
 * The three fields of one smart-routing rule: the plain-language rule, and the
 * models and efforts a turn may be moved to. Scoped to one provider — routing
 * never crosses providers, so the model list is filtered to it.
 */
export function RoutingRuleFields({
  provider,
  models,
  value,
  onChange,
  disabled,
}: {
  provider: ModelProvider;
  models: ModelOption[];
  value: RoutingRule;
  onChange: (next: RoutingRule) => void;
  disabled?: boolean;
}) {
  // Auto is not a level routing can pick: the pick is always an explicit effort.
  const effortData = effortSelectData(capabilitiesFor(provider).reasoningEfforts).filter(
    (e) => e.value !== 'auto',
  );
  return (
    <Stack gap="xs">
      <Textarea
        label="Rule"
        description="When to pick which model and effort, in plain words."
        placeholder="Max effort for architecture or debugging questions, or after a failed turn; low for small edits."
        autosize
        minRows={2}
        value={value.rule}
        disabled={disabled}
        onChange={(e) => onChange({ ...value, rule: e.currentTarget.value })}
      />
      <MultiSelect
        label="Allowed models"
        data={modelSelectData(models, undefined, { providers: [provider] }).map(({ value: v, label }) => ({
          value: v,
          label,
        }))}
        value={value.models}
        disabled={disabled}
        onChange={(models) => onChange({ ...value, models })}
      />
      <MultiSelect
        label="Allowed efforts"
        data={effortData.map(({ value: v, label }) => ({ value: v, label }))}
        value={value.efforts}
        disabled={disabled}
        onChange={(efforts) => onChange({ ...value, efforts: efforts as ReasoningEffort[] })}
      />
    </Stack>
  );
}
