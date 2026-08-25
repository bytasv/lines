import { Tooltip } from '@mantine/core';
import type { PermissionMode } from '@lines/shared';
import { type DescribedItem, renderOptionWithDescription } from './modelSelect';

export interface PermissionModeItem extends DescribedItem {
  value: PermissionMode;
  description: string;
}

/**
 * The single source of truth for permission-mode copy — the composer/settings
 * segmented controls and the workflow step Selects all read from here, so a
 * label edit lands in every picker at once. Keep labels to one short word: the
 * composer segments are narrow and wrap otherwise.
 */
export const PERMISSION_MODES: PermissionModeItem[] = [
  { value: 'default', label: 'Manual', description: 'Asks before each file edit or command.' },
  {
    value: 'auto',
    label: 'Auto',
    description: 'Safe tools run on their own; the guard still asks for risky ones.',
  },
  {
    value: 'acceptEdits',
    label: 'Edits',
    description: 'File edits apply without asking; other tools still ask.',
  },
  {
    value: 'plan',
    label: 'Plan',
    description: 'Research only — proposes a plan, changes nothing until you approve.',
  },
  {
    value: 'bypassPermissions',
    label: 'Bypass',
    description: 'Runs every tool without asking. Plan approval and questions still ask. Sandbox only.',
  },
];

/**
 * SegmentedControl has no per-item tooltip prop, so the description rides along
 * as a Tooltip-wrapped label node. The span must fill the segment or the hover
 * target shrinks to the text and the segment padding stops triggering it.
 */
export const PERMISSION_MODE_SEGMENTS = PERMISSION_MODES.map(({ value, label, description }) => ({
  value,
  label: (
    <Tooltip label={description} withArrow>
      <span style={{ display: 'block', width: '100%' }}>{label}</span>
    </Tooltip>
  ),
}));

export function permissionModeLabel(value: string): string {
  return PERMISSION_MODES.find((m) => m.value === value)?.label ?? value;
}

export const renderPermissionModeOption = renderOptionWithDescription;
