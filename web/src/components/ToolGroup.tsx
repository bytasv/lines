import { useState } from 'react';
import { Badge, Collapse, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconTools } from '@tabler/icons-react';
import type { ToolGroupItem } from '../lib/transcript';
import { groupDiffTotals, groupSummary } from '../lib/transcript';
import { ToolCallCard } from './ToolCallCard';

// Sticky per-group override, keyed `${sessionId}:${group.key}`. Module scope so it
// survives Transcript remount (switching sessions) and transcript rebuilds.
const stickyOverrides = new Map<string, boolean>();

export function ToolGroup({
  group,
  active,
  sessionId,
}: {
  group: ToolGroupItem;
  active: boolean;
  sessionId: string;
}) {
  const k = `${sessionId}:${group.key}`;
  const [override, setOverride] = useState<boolean | null>(() => stickyOverrides.get(k) ?? null);

  // A lone tool call needs no group chrome — the card is already collapsible.
  if (group.tools.length === 1) return <ToolCallCard tool={group.tools[0]} />;

  const expanded = override ?? active;
  const toggle = () => {
    stickyOverrides.set(k, !expanded);
    setOverride(!expanded);
  };

  const failed = group.tools.filter((t) => t.isError).length;
  const totals = groupDiffTotals(group.tools);

  return (
    <Paper withBorder radius="md" px="sm" py={6} bg="var(--mantine-color-default)">
      <Group gap="xs" wrap="nowrap" justify="space-between">
        <Group
          gap="xs"
          wrap="nowrap"
          style={{ cursor: 'pointer', minWidth: 0, flex: 1 }}
          onClick={toggle}
        >
          {expanded ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          <IconTools size={13} opacity={0.6} />
          <Text size="xs" fw={600} style={{ flexShrink: 0 }}>
            {groupSummary(group.tools)}
          </Text>
          {group.labelText && (
            <Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
              {group.labelText}
            </Text>
          )}
        </Group>
        <Group gap={6} wrap="nowrap">
          {failed > 0 && (
            <Badge variant="light" color="red" tt="none">
              {failed} failed
            </Badge>
          )}
          {totals && (
            <Text size="xs" ff="monospace">
              <Text span c="teal">
                +{totals.added}
              </Text>{' '}
              <Text span c="red">
                −{totals.removed}
              </Text>
            </Text>
          )}
          {active && <Loader size={12} />}
        </Group>
      </Group>
      <Collapse expanded={expanded} transitionDuration={150}>
        <Stack gap={6} mt={6}>
          {group.tools.map((t) => (
            <ToolCallCard key={t.id} tool={t} />
          ))}
        </Stack>
      </Collapse>
    </Paper>
  );
}
