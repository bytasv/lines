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
 * Which modes get a pill, in the order they appear — deliberately both a subset
 * and a re-ordering of `PERMISSION_MODES`, which keeps all five in its own order
 * for the workflow Selects. Mapping over this list rather than filtering the
 * array is what lets the segments read as one escalating scale (Plan changes
 * nothing, Assist acts on what the guard clears, Full Auto acts on everything)
 * while the copy still comes from the one source. `default` and `acceptEdits`
 * stay selectable in the Selects, they just have no pill.
 */
const SEGMENT_MODES: PermissionMode[] = ['plan', 'auto', 'bypassPermissions'];

/**
 * SegmentedControl has no per-item tooltip prop, so the description rides along
 * as a Tooltip-wrapped label node. The span must fill the segment or the hover
 * target shrinks to the text and the segment padding stops triggering it.
 */
export const PERMISSION_MODE_SEGMENTS = SEGMENT_MODES.map((value) => {
  const mode = PERMISSION_MODES.find((m) => m.value === value)!;
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
