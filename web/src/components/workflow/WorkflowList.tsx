import { Box, Button, Group, Menu, ScrollArea, Stack, Text } from '@mantine/core';
import { IconChevronDown, IconPlus } from '@tabler/icons-react';
import type { WorkflowDef } from '@lines/shared';
import { WORKFLOW_PRESETS } from '../../lib/workflowPresets';
import type { WorkflowPreset } from '../../lib/workflowPresets';

function DirtyDot() {
  return (
    <Box
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: 'var(--mantine-color-sandstone-6)',
        flexShrink: 0,
      }}
    />
  );
}

export function WorkflowList({
  workflows,
  sharedWorkflows,
  selectedId,
  dirty,
  onSelect,
  onNew,
}: {
  workflows: WorkflowDef[];
  sharedWorkflows: WorkflowDef[];
  selectedId: string | null;
  dirty: boolean;
  onSelect: (w: WorkflowDef) => void;
  onNew: (preset: WorkflowPreset | null) => void;
}) {
  // An id in both lists is the user's own (a stale shared snapshot, or their own
  // published row pulled back under a second identity) — render it once, above.
  const foreign = sharedWorkflows.filter((s) => !workflows.some((w) => w.id === s.id));
  return (
    <Stack gap="xs" w={240} style={{ flexShrink: 0 }} h="100%">
      <ScrollArea style={{ flex: 1 }} type="hover">
        <Stack gap="xs" pr="xs">
          {workflows.map((w) => (
            <Button
              key={w.id}
              variant={w.id === selectedId ? 'light' : 'subtle'}
              color="gray"
              justify="start"
              onClick={() => onSelect(w)}
            >
              <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                <Text size="xs" truncate>
                  {w.name}
                </Text>
                {w.id === selectedId && dirty && <DirtyDot />}
              </Group>
            </Button>
          ))}
          {foreign.length > 0 && (
            <>
              <Text size="xs" fw={600} c="dimmed" tt="uppercase" mt="xs">
                Shared by others
              </Text>
              {foreign.map((w) => (
                <Button
                  key={w.id}
                  variant={w.id === selectedId ? 'light' : 'subtle'}
                  color="gray"
                  justify="start"
                  onClick={() => onSelect(w)}
                >
                  <Stack gap={0} style={{ minWidth: 0 }}>
                    <Text size="xs" truncate>
                      {w.name}
                    </Text>
                    <Text size="10px" c="dimmed" truncate>
                      {w.ownerName ?? 'Unknown'}
                    </Text>
                  </Stack>
                </Button>
              ))}
            </>
          )}
        </Stack>
      </ScrollArea>
      <Menu position="bottom-start" width={240} withinPortal>
        <Menu.Target>
          <Button variant="default" leftSection={<IconPlus size={13} />} rightSection={<IconChevronDown size={13} />}>
            New workflow
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={() => onNew(null)}>Blank workflow</Menu.Item>
          <Menu.Label>From preset</Menu.Label>
          {WORKFLOW_PRESETS.map((p) => (
            <Menu.Item key={p.id} onClick={() => onNew(p)}>
              <Text size="sm">{p.name}</Text>
              <Text size="xs" c="dimmed">
                {p.description}
              </Text>
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </Stack>
  );
}
