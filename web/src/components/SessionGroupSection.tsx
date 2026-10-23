import { ActionIcon, Box, Button, Center, Group, Menu, Popover, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { IconBellOff, IconChevronDown, IconDots } from '@tabler/icons-react';
import type { DraggableProvidedDragHandleProps } from '@hello-pangea/dnd';
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { SessionMeta } from '@lines/shared';
import { compareSessions, sessionRowMeta } from '../lib/format';

/** What muting a group does, shown wherever Mute/Unmute is offered. */
export const MUTE_TOOLTIP =
  'Muted: no notifications, no project tab dot, and never auto-opened. Sessions still run normally.';

/** The most urgent actionable state among `sessions`, for a collapsed header's dot. */
function urgentMeta(sessions: SessionMeta[]): ReturnType<typeof sessionRowMeta> | null {
  const top = [...sessions].sort(compareSessions('status'))[0];
  if (!top) return null;
  const meta = sessionRowMeta(top);
  return meta.actionable ? meta : null;
}

/**
 * One collapsible block of sidebar rows: a user-made group, or Archived. The
 * header and collapse logic live here once, so both read and behave the same.
 *
 * Collapsed, the header still carries the most urgent actionable dot among its
 * sessions — a parked group with a permission prompt inside must not go silent —
 * unless the group is muted, which is exactly what muting asks for.
 */
export function SessionGroupSection({
  title,
  sessions,
  collapsed,
  onToggle,
  muted,
  menu,
  dragHandleProps,
  rename,
  children,
}: {
  title: string;
  /** Every session in the section, including any not rendered yet (paging). */
  sessions: SessionMeta[];
  collapsed: boolean;
  onToggle: () => void;
  muted?: boolean;
  /** `Menu.Item`s for the header's ⋯ menu; no menu when absent. */
  menu?: ReactNode;
  /** The header is the drag handle when the section can be reordered. */
  dragHandleProps?: DraggableProvidedDragHandleProps | null;
  /** The rename field, anchored to the header while open. */
  rename?: { opened: boolean; onClose: () => void; onSubmit: (name: string) => void };
  children: ReactNode;
}) {
  const urgent = collapsed && !muted ? urgentMeta(sessions) : null;
  const header = (
    <Group gap={4} justify="space-between" wrap="nowrap" px="sm" pt={4} {...dragHandleProps}>
      <UnstyledButton
        onClick={onToggle}
        aria-expanded={!collapsed}
        style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 4 }}
      >
        <IconChevronDown
          size={14}
          color="var(--mantine-color-dimmed)"
          style={{
            flexShrink: 0,
            transform: collapsed ? 'rotate(-90deg)' : undefined,
            transition: 'transform 120ms',
          }}
        />
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" truncate>
          {title} ({sessions.length})
        </Text>
        {muted && (
          <Tooltip label={MUTE_TOOLTIP} multiline maw={260} withArrow openDelay={300}>
            <Center c="dimmed" style={{ flexShrink: 0 }}>
              <IconBellOff size={12} />
            </Center>
          </Tooltip>
        )}
        {urgent && (
          <Tooltip label={urgent.label} withArrow openDelay={300}>
            <span
              className="status-dot"
              data-pulse
              style={
                {
                  flexShrink: 0,
                  '--status-dot-color': `var(--mantine-color-${urgent.color}-6)`,
                  '--status-pulse-color': `var(--mantine-color-${urgent.color}-5)`,
                } as CSSProperties
              }
            />
          </Tooltip>
        )}
      </UnstyledButton>
      {menu && (
        <Menu withinPortal position="bottom-end">
          <Menu.Target>
            <ActionIcon size="xs" variant="subtle" color="gray" aria-label={`Actions for ${title}`}>
              <IconDots size={14} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>{menu}</Menu.Dropdown>
        </Menu>
      )}
    </Group>
  );
  return (
    <Box>
      {rename ? (
        <GroupNamePopover {...rename} initial={title} submitLabel="Rename">
          {header}
        </GroupNamePopover>
      ) : (
        header
      )}
      {!collapsed && children}
    </Box>
  );
}

/**
 * A name field anchored to `children`, for creating or renaming a group. Opened
 * from a header button or a menu item, so it is controlled: the menu that opened
 * it has already closed by the time it shows.
 */
export function GroupNamePopover({
  opened,
  onClose,
  onSubmit,
  initial = '',
  submitLabel,
  children,
}: {
  opened: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
  initial?: string;
  submitLabel: string;
  children: ReactNode;
}) {
  const [name, setName] = useState(initial);
  useEffect(() => {
    if (opened) setName(initial);
  }, [opened, initial]);
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    onClose();
  };
  return (
    <Popover opened={opened} onChange={(o) => !o && onClose()} position="bottom-end" withArrow trapFocus withinPortal>
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown onClick={(e) => e.stopPropagation()}>
        <Group gap={6} wrap="nowrap">
          <TextInput
            size="xs"
            placeholder="Group name"
            value={name}
            data-autofocus
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') onClose();
            }}
          />
          <Button size="compact-xs" onClick={submit} disabled={!name.trim()}>
            {submitLabel}
          </Button>
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
}
