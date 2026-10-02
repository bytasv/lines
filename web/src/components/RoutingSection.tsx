import { useId, useState } from 'react';
import { Alert, Button, Group, PasswordInput, SegmentedControl, Stack, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import type { ModelProvider, RoutingMode, RoutingRule } from '@lines/shared';
import { validateRoutingRule } from '@lines/shared';
import { emptyRoutingRule, RoutingRuleFields } from './RoutingRuleFields';
import { useStore } from '../store';
import { useIsGuest } from '../lib/can';
import { SettingsGroup, SettingsRow } from './SettingsLayout';

const ROUTING_MODE_SEGMENTS: { value: RoutingMode; label: string }[] = [
  { value: 'off', label: 'Disabled' },
  { value: 'auto', label: 'Enabled, auto' },
  { value: 'ask', label: 'Enabled, ask' },
];

/**
 * Smart routing: JEV may move each turn to another allowed model or effort.
 * Global, one rule per connected provider. The mode applies at once; a rule is
 * saved with its own button, because the bridge refuses an incomplete one and a
 * save per keystroke would be refused until the last.
 */
export function RoutingSection() {
  const models = useStore((s) => s.models);
  const openaiConnected = useStore((s) => s.openaiAuth?.loggedIn === true);
  const available = useStore((s) => s.smartRoutingAvailable);
  const routing = useStore((s) => s.smartRouting);
  const setSmartRouting = useStore((s) => s.setSmartRouting);
  const guest = useIsGuest();
  const mode = routing?.mode ?? 'off';
  const rules = routing?.rules ?? {};
  const providers: ModelProvider[] = openaiConnected ? ['anthropic', 'openai'] : ['anthropic'];

  return (
    <>
      {/* What leaves the machine stays in view, under the switch that sends it. */}
      <SettingsGroup footer="The turn's prompt text is sent to TypeSafe; the transcript is not. A manual model or effort change pauses routing for that session.">
        <SettingsRow
          label="Mode"
          controlWidth={300}
          control={
            <SegmentedControl
              size="xs"
              fullWidth
              data={ROUTING_MODE_SEGMENTS}
              value={mode}
              onChange={(v) => setSmartRouting({ mode: v as RoutingMode, rules })}
            />
          }
        />
      </SettingsGroup>
      {!guest && available !== null && <TypesafeKeyField available={available} />}
      {mode !== 'off' && (
        <SettingsGroup title="Rules">
          {providers.map((provider) => (
            <ProviderRoutingRule
              key={provider}
              provider={provider}
              models={models}
              saved={rules[provider]}
              onSave={(rule) => {
                const next = { ...rules };
                if (rule) next[provider] = rule;
                else delete next[provider];
                setSmartRouting({ mode, rules: next });
              }}
            />
          ))}
        </SettingsGroup>
      )}
    </>
  );
}

/**
 * This user's TypeSafe key, on this machine only. Write-only: the bridge never
 * sends it back, so the saved state shows no part of it.
 */
function TypesafeKeyField({ available }: { available: boolean }) {
  const id = useId();
  const setTypesafeKey = useStore((s) => s.setTypesafeKey);
  const clearTypesafeKey = useStore((s) => s.clearTypesafeKey);
  const [key, setKey] = useState('');
  const trimmed = key.trim();

  if (available) {
    return (
      <SettingsGroup>
        <SettingsRow
          label="TypeSafe API key"
          description="Saved on this machine. It is never synced; each machine needs its own."
          control={
            <Button size="xs" variant="default" onClick={clearTypesafeKey}>
              Remove
            </Button>
          }
        />
      </SettingsGroup>
    );
  }
  return (
    <SettingsGroup>
      <SettingsRow
        label="TypeSafe API key"
        htmlFor={id}
        description="Stored only on this machine and never synced. Enter it on each machine you use."
      >
        <Alert color="yellow" icon={<IconAlertCircle size={16} />} p="xs">
          No TypeSafe API key on this machine. Until you add one, every turn runs on its current
          settings.
        </Alert>
        <Group gap="xs" wrap="nowrap">
          <PasswordInput
            id={id}
            size="xs"
            style={{ flex: 1 }}
            value={key}
            onChange={(e) => setKey(e.currentTarget.value)}
            autoComplete="off"
          />
          <Button
            size="xs"
            disabled={!trimmed}
            onClick={() => {
              setTypesafeKey(trimmed);
              setKey('');
            }}
          >
            Save
          </Button>
        </Group>
      </SettingsRow>
    </SettingsGroup>
  );
}

function ProviderRoutingRule({
  provider,
  models,
  saved,
  onSave,
}: {
  provider: ModelProvider;
  models: ReturnType<typeof useStore.getState>['models'];
  saved: RoutingRule | undefined;
  onSave: (rule: RoutingRule | null) => void;
}) {
  const [draft, setDraft] = useState<RoutingRule>(saved ?? emptyRoutingRule());
  // Follow a save from another tab, unless this one is mid-edit.
  const savedJson = JSON.stringify(saved ?? null);
  const [lastSaved, setLastSaved] = useState(savedJson);
  if (savedJson !== lastSaved) {
    setLastSaved(savedJson);
    setDraft(saved ?? emptyRoutingRule());
  }
  const issues = validateRoutingRule(draft, provider);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved ?? emptyRoutingRule());
  return (
    <SettingsRow label={provider === 'openai' ? 'OpenAI sessions' : 'Claude sessions'}>
      <Stack gap="xs">
        <RoutingRuleFields provider={provider} models={models} value={draft} onChange={setDraft} />
        {dirty && issues.length > 0 && (
          <Text size="xs" c="red">
            {issues[0]}
          </Text>
        )}
        <Group gap="xs">
          <Button size="xs" disabled={!dirty || issues.length > 0} onClick={() => onSave(draft)}>
            Save rule
          </Button>
          {saved && (
            <Button size="xs" variant="subtle" color="gray" onClick={() => onSave(null)}>
              Remove rule
            </Button>
          )}
        </Group>
      </Stack>
    </SettingsRow>
  );
}
