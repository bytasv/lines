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
 * label edit lands in every picker at once. Keep labels short: the segments are
 * narrow, and anything longer than "Full Auto" wraps.
 */
export const PERMISSION_MODES: PermissionModeItem[] = [
  { value: 'default', label: 'Manual', description: 'Asks before each file edit or command.' },
  {
    value: 'auto',
    label: 'Assist',
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
    label: 'Full Auto',
    description: 'Runs every tool without asking. Plan approval and questions still ask. Sandbox only.',
  },
];

/**
 * The modes every picker offers, in the order they appear — deliberately both a
 * subset and a re-ordering of `PERMISSION_MODES`, which keeps all five so labels
 * still resolve for stored legacy values. Mapping over this list rather than
 * filtering the array is what lets the choices read as one escalating scale
 * (Plan changes nothing, Assist acts on what the guard clears, Full Auto acts on
 * everything) while the copy still comes from the one source. `default` and
 * `acceptEdits` remain valid stored values that still run; they are just no
 * longer offered for new choices.
 */
export const SEGMENT_MODES: PermissionMode[] = ['plan', 'auto', 'bypassPermissions'];

const modeItem = (value: PermissionMode) => PERMISSION_MODES.find((m) => m.value === value)!;

/**
 * Select data for a permission-mode picker: the `SEGMENT_MODES`, plus `current`
 * when it is a legacy value outside them, so a step that already holds one shows
 * it instead of going blank. Stored values are never rewritten here — moving
 * `default` to `auto` would silently raise what an existing step may do.
 */
export function permissionModeSelectData(current: PermissionMode): PermissionModeItem[] {
  const items = SEGMENT_MODES.map(modeItem);
  return SEGMENT_MODES.includes(current) ? items : [...items, modeItem(current)];
}

/**
 * SegmentedControl has no per-item tooltip prop, so the description rides along
 * as a Tooltip-wrapped label node. The span must fill the segment or the hover
 * target shrinks to the text and the segment padding stops triggering it.
 */
export const PERMISSION_MODE_SEGMENTS = SEGMENT_MODES.map((value) => {
  const mode = modeItem(value);
  return {
    value,
    label: (
      <Tooltip label={mode.description} withArrow>
        <span style={{ display: 'block', width: '100%' }}>{mode.label}</span>
      </Tooltip>
    ),
  };
});

export function permissionModeLabel(value: string): string {
  return PERMISSION_MODES.find((m) => m.value === value)?.label ?? value;
}

export const renderPermissionModeOption = renderOptionWithDescription;
