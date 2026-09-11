import { memo, useState } from 'react';
import { Badge, Box, Collapse, Group, Loader, Stack, Text } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { ToolGroupItem, TranscriptItem } from '../lib/transcript';
import { groupDiffTotals, groupSummary } from '../lib/transcript';
import { ToolCallCard } from './ToolCallCard';

// Sticky per-group override, keyed `${sessionId}:${group.key}`. Module scope so it
// survives Transcript remount (switching sessions) and transcript rebuilds.
const stickyOverrides = new Map<string, boolean>();

/**
 * Memoized: the group's header alone walks every tool call and diffs the edits.
 * `group` keeps its identity across rebuilds that didn't touch it (reconcileItems),
 * and `renderNested` is stable by construction in Transcript — without both, this
 * memo silently does nothing.
 */
export const ToolGroup = memo(function ToolGroup({
  group,
  active,
  sessionId,
  renderNested,
}: {
  group: ToolGroupItem;
  active: boolean;
  sessionId: string;
  /** Renders a subagent's items inside a Task card. Threaded through from Transcript. */
  renderNested?: (items: TranscriptItem[]) => ReactNode;
}) {
  const k = `${sessionId}:${group.key}`;
  const [override, setOverride] = useState<boolean | null>(() => stickyOverrides.get(k) ?? null);

  // A lone tool call needs no group chrome — the card is already collapsible.
  if (group.tools.length === 1) {
    return <ToolCallCard tool={group.tools[0]} renderNested={renderNested} />;
  }

  const expanded = override ?? active;
  const toggle = () => {
    stickyOverrides.set(k, !expanded);
    setOverride(!expanded);
  };

  const failed = group.tools.filter((t) => t.isError).length;
  const totals = groupDiffTotals(group.tools);

  return (
    <Box>
      <Group
        className="tx-row"
        gap="xs"
        wrap="nowrap"
        justify="space-between"
        onClick={toggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
          {expanded ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          <Text size="xs" fw={600} style={{ flexShrink: 0 }}>
            {groupSummary(group.tools)}
          </Text>
          {group.labelText && (
            <Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
              {group.labelText}
            </Text>
          )}
        </Group>
        <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
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
      {/* Cards are mounted only while the group is open — a collapsed group must
          not pay for rendering the tool calls it is hiding. Their own expansion
          is kept in ToolCallCard's sticky map, so it survives the unmount. */}
      <Collapse expanded={expanded} transitionDuration={150}>
        {expanded && (
          <Stack gap={2} mt={2}>
            {group.tools.map((t) => (
              <ToolCallCard key={t.id} tool={t} renderNested={renderNested} />
            ))}
          </Stack>
        )}
      </Collapse>
    </Box>
  );
});
