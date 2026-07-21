import { Group, HoverCard, Progress, RingProgress, Stack, Text, UnstyledButton } from '@mantine/core';
import { useStore } from '../store';

/** Green under 50%, amber to 80%, red above — mirrors ClaudeUsageBar's thresholds. */
function usageColor(pct: number): string {
  return pct >= 80 ? 'red' : pct >= 50 ? 'yellow' : 'teal';
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: 'Session (5h)',
  seven_day: 'Weekly (all models)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_opus: 'Weekly (Opus)',
};

function windowLabel(id: string): string {
  return WINDOW_LABELS[id] ?? id.replace(/_/g, ' ');
}

/** "Resets in 2h 14m" from an ISO timestamp; null when unknown or already elapsed. */
function formatResetIn(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `Resets in ${h > 0 ? `${h}h ${m}m` : `${m}m`}`;
}

function formatAgo(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return 'Updated just now';
  return `Updated ${mins}m ago`;
}

export function UsageIndicator() {
  const usage = useStore((s) => s.usage);
  if (!usage || usage.windows.length === 0) return null;

  const worst = usage.windows.reduce((a, b) => (b.utilization > a.utilization ? b : a), usage.windows[0]);
  const primary = usage.windows.find((w) => w.id === 'five_hour') ?? worst;

  return (
    <HoverCard width={280} position="bottom-end" withArrow shadow="md" openDelay={100} closeDelay={100}>
      <HoverCard.Target>
        <UnstyledButton
          aria-label="Claude plan usage"
          style={{ display: 'flex', alignItems: 'center' }}
        >
          <RingProgress
            size={38}
            thickness={4}
            sections={[{ value: primary.utilization, color: usageColor(worst.utilization) }]}
            label={
              <Text size="8px" ta="center" fw={700}>
                {Math.round(primary.utilization)}
              </Text>
            }
          />
        </UnstyledButton>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Stack gap="xs">
          <Text size="xs" fw={700} tt="uppercase" c="dimmed">
            Claude plan usage
          </Text>
          {usage.windows.map((w) => {
            const resets = formatResetIn(w.resetsAt);
            return (
              <div key={w.id}>
                <Group justify="space-between" gap="xs" mb={2}>
                  <Text size="xs">{windowLabel(w.id)}</Text>
                  <Text size="xs" fw={600}>
                    {Math.round(w.utilization)}%
                  </Text>
                </Group>
                <Progress value={w.utilization} color={usageColor(w.utilization)} size="sm" />
                {resets && (
                  <Text size="xs" c="dimmed" mt={2}>
                    {resets}
                  </Text>
                )}
              </div>
            );
          })}
          <Text size="xs" c="dimmed">
            {formatAgo(usage.fetchedAt)}
          </Text>
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
