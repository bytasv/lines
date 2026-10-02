import { SegmentedControl } from '@mantine/core';
import { useStore, type CompactionLevel } from '../store';
import { SettingsGroup, SettingsRow, SettingsSwitchRow } from './SettingsLayout';

export function TranscriptSection() {
  const compactionLevel = useStore((s) => s.compactionLevel);
  const setCompactionLevel = useStore((s) => s.setCompactionLevel);
  const turnSummariesEnabled = useStore((s) => s.turnSummariesEnabled);
  const setTurnSummariesEnabled = useStore((s) => s.setTurnSummariesEnabled);

  return (
    <SettingsGroup>
      <SettingsRow
        label="Compaction"
        controlWidth={240}
        control={
          <SegmentedControl
            size="xs"
            fullWidth
            data={[
              { value: 'full', label: 'Full' },
              { value: 'grouped', label: 'Grouped' },
              { value: 'compact', label: 'Compact' },
            ]}
            value={compactionLevel}
            onChange={(v) => setCompactionLevel(v as CompactionLevel)}
          />
        }
      />
      <SettingsSwitchRow
        label="AI turn summaries"
        description="Summarize each turn's actions in a sentence; off shows the agent's own narration instead"
        checked={turnSummariesEnabled}
        onChange={setTurnSummariesEnabled}
      />
    </SettingsGroup>
  );
}
