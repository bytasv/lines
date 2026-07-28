import { useState } from 'react';
import { ActionIcon, Alert, Autocomplete, Button, Code, Group, Text, TextInput, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconPlus, IconTrash } from '@tabler/icons-react';
import { describeAllowEntry, normalizeAllowEntry, sameAllowEntry } from '@lines/shared';
import { useStore } from '../store';
import { GUARD_TOOL_SUGGESTIONS, guardEntryErrorText, isBroadBashPrefix } from '../lib/guardEntries';

/**
 * The auto-mode guard's exception list, made visible and editable. Every entry
 * here is a tool call the guard will stop asking about, so the add path runs the
 * same shared validator the bridge does — a row that looks right but can never
 * match would be worse than no row at all.
 *
 * Removal has no confirmation on purpose: it narrows the guard, so it fails safe.
 * Guarding the safe direction while the risky one (add) is unguarded would train
 * the wrong reflex.
 */
export function GuardAllowlistSection({ onOpenReview }: { onOpenReview: () => void }) {
  const entries = useStore((s) => s.guardAllowlist);
  const review = useStore((s) => s.guardReview);
  const addGuardAllow = useStore((s) => s.addGuardAllow);
  const removeGuardAllow = useStore((s) => s.removeGuardAllow);
  const [tool, setTool] = useState('');
  const [prefix, setPrefix] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const result = normalizeAllowEntry({ tool, prefix });
    if ('error' in result) {
      setError(guardEntryErrorText(result.error));
      return;
    }
    if (entries.some((e) => sameAllowEntry(e, result.entry))) {
      setError('Already allowlisted');
      return;
    }
    addGuardAllow(result.entry);
    setTool('');
    setPrefix('');
    setError(null);
  };

  const firstToken = prefix.trim().split(/\s+/)[0];
  const broadWarning =
    tool === 'Bash' && firstToken && isBroadBashPrefix(prefix)
      ? `Allows every ${firstToken} subcommand, including force pushes.`
      : null;

  return (
    <>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase" mt="sm">
        Auto-mode allowlist
      </Text>
      {review && (
        <Alert color="yellow" icon={<IconAlertTriangle size={16} />} p="xs">
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Text size="sm">This list changed on another machine.</Text>
            <Button size="xs" variant="default" onClick={onOpenReview}>
              Review…
            </Button>
          </Group>
        </Alert>
      )}
      <Text size="xs" c="dimmed">
        Calls matching these skip the guard in Auto mode. Everything else still asks.
      </Text>
      {entries.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nothing allowlisted yet.
        </Text>
      ) : (
        entries.map((entry) => {
          const label = describeAllowEntry(entry);
          return (
            <Group key={label} justify="space-between" wrap="nowrap">
              <Code>{label}</Code>
              <Tooltip label="Remove">
                <ActionIcon
                  variant="subtle"
                  color="red"
                  size="sm"
                  aria-label={`Remove ${label}`}
                  onClick={() => removeGuardAllow(entry)}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Tooltip>
            </Group>
          );
        })
      )}
      <Group gap="xs" align="flex-end" wrap="nowrap">
        <Autocomplete
          label="Tool"
          size="sm"
          placeholder="Bash"
          // Autocomplete, not Select: mcp__server__tool names must be typeable.
          data={GUARD_TOOL_SUGGESTIONS}
          value={tool}
          onChange={(v) => {
            setTool(v);
            setError(null);
          }}
          w={150}
        />
        <TextInput
          label="Command prefix"
          size="sm"
          placeholder="npm run"
          value={prefix}
          onChange={(e) => {
            setPrefix(e.currentTarget.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          disabled={tool !== 'Bash'}
          style={{ flex: 1 }}
        />
        <Tooltip label="Add">
          <ActionIcon
            variant="default"
            size="input-sm"
            aria-label="Add allowlist entry"
            onClick={submit}
          >
            <IconPlus size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
      {error && (
        <Text size="xs" c="red">
          {error}
        </Text>
      )}
      {broadWarning && (
        <Text size="xs" c="dimmed">
          {broadWarning}
        </Text>
      )}
    </>
  );
}
