import {
  Anchor,
  Box,
  Divider,
  Group,
  HoverCard,
  Progress,
  RingProgress,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { mergeSpend, providerForModel, sortedSpend } from '@lines/shared';
import type { ClientMessage, ModelOption, ModelProvider, ModelSpend, UsageSnapshot } from '@lines/shared';
import { useStore } from '../store';
import { send } from '../ws';
import { formatTokens, usageColor } from '../lib/format';
import { ProviderBadge } from './ProviderMark';

/** Anthropic names its windows with stable keys, so the label is a lookup. OpenAI
 *  reports only primary/secondary plus a duration, so its labels ride on the
 *  window itself (see UsageWindow.label). */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: 'Session (5h)',
  seven_day: 'Weekly (all models)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_opus: 'Weekly (Opus)',
};

function windowLabel(id: string, label?: string): string {
  return label ?? WINDOW_LABELS[id] ?? id.replace(/_/g, ' ');
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

/** Human label for a spend row; a retired or unknown id still shows as itself. */
function modelLabel(id: string, models: ModelOption[]): string {
  return models.find((m) => m.id === id)?.label ?? id;
}

/**
 * Spend rows. The cost half is dropped when a row has none rather than printed as
 * `$0.00`: codex reports tokens but no USD, so a column of zeroes would read as
 * "these turns were free" instead of "we are not told".
 */
function SpendRows({ rows, models }: { rows: [string, ModelSpend][]; models: ModelOption[] }) {
  return (
    <>
      {rows.map(([id, spend]) => (
        <Group key={id} justify="space-between" gap="xs">
          <Text size="xs" truncate>
            {modelLabel(id, models)}
          </Text>
          <Text size="xs" c="dimmed">
            {spend.costUsd > 0 ? `$${spend.costUsd.toFixed(2)} · ` : ''}
            {formatTokens(spend.tokens)}
          </Text>
        </Group>
      ))}
    </>
  );
}

interface PlanUsageChipProps {
  provider: ModelProvider;
  usage: UsageSnapshot;
  /** Dropdown heading, e.g. "Claude plan usage". */
  title: string;
  /** Account line at the foot of the dropdown; absent renders no footer. */
  accountLabel?: string;
  /** Copy and message for the footer's disconnect action. */
  signOut: { label: string; message: ClientMessage };
  /** Rows for this provider's models only — each chip accounts for its own. */
  globalRows: [string, ModelSpend][];
  sessionRows: [string, ModelSpend][];
  models: ModelOption[];
  /** Show the brand mark. Only when a second provider is connected: with one chip
   *  on screen there is nothing to disambiguate it from. */
  withMark: boolean;
}

/**
 * One provider's plan-usage ring and its dropdown.
 *
 * Deliberately one component rendered twice rather than two: the two providers
 * report the same thing (percent consumed, when it resets), so a second copy
 * would be the one that quietly stops matching. What differs between them is
 * data — which windows exist, whether a cost is reported — and that is passed in.
 */
function PlanUsageChip({
  provider,
  usage,
  title,
  accountLabel,
  signOut,
  globalRows,
  sessionRows,
  models,
  withMark,
}: PlanUsageChipProps) {
  const worst = usage.windows.reduce((a, b) => (b.utilization > a.utilization ? b : a), usage.windows[0]);
  // Anthropic's session window by name where it exists, else simply the first —
  // OpenAI's primary window is already first (see parseOpenaiUsage).
  const primary = usage.windows.find((w) => w.id === 'five_hour') ?? usage.windows[0];

  return (
    <HoverCard width={280} position="bottom-end" withArrow shadow="md" openDelay={100} closeDelay={100}>
      <HoverCard.Target>
        <UnstyledButton aria-label={title} style={{ display: 'flex', alignItems: 'center' }}>
          {/* Relative, so the badge can sit on the ring's corner without widening
              the button — both chips stay the same size either way. */}
          <Box style={{ position: 'relative', display: 'flex' }}>
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
            {withMark && <ProviderBadge provider={provider} />}
          </Box>
        </UnstyledButton>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Stack gap="xs">
          <Text size="xs" fw={700} tt="uppercase" c="dimmed">
            {title}
          </Text>
          {usage.windows.map((w) => {
            const resets = formatResetIn(w.resetsAt);
            return (
              <div key={w.id}>
                <Group justify="space-between" gap="xs" mb={2}>
                  <Text size="xs">{windowLabel(w.id, w.label)}</Text>
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
          {globalRows.length > 0 && (
            <>
              <Divider />
              <Text size="xs" fw={700} tt="uppercase" c="dimmed">
                Spend by model
              </Text>
              <SpendRows rows={globalRows} models={models} />
              {/* A single-model session adds nothing over the sidebar's own total. */}
              {sessionRows.length > 1 && (
                <>
                  <Text size="xs" fw={700} tt="uppercase" c="dimmed">
                    This session
                  </Text>
                  <SpendRows rows={sessionRows} models={models} />
                </>
              )}
            </>
          )}
          <Text size="xs" c="dimmed">
            {formatAgo(usage.fetchedAt)}
          </Text>
          {accountLabel && (
            <>
              <Divider />
              <Group justify="space-between" gap="xs">
                <Text size="xs" c="dimmed" truncate>
                  {accountLabel}
                </Text>
                <Anchor
                  component="button"
                  type="button"
                  size="xs"
                  c="red"
                  onClick={() => send(signOut.message)}
                >
                  {signOut.label}
                </Anchor>
              </Group>
            </>
          )}
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/** Spend keyed by model, narrowed to one provider's models. */
function rowsFor(spend: Record<string, ModelSpend>, provider: ModelProvider): [string, ModelSpend][] {
  return sortedSpend(spend).filter(([id]) => providerForModel(id) === provider);
}

/**
 * The plan-usage chips in the header — one per connected provider.
 *
 * Each renders only what its provider actually reports, and neither appears
 * without a reading: a chip with no windows would be a ring that could never
 * fill. That is also why there is no "connect OpenAI" affordance here — Settings
 * → Account owns that, and an empty ring is not an invitation.
 */
export function UsageIndicator() {
  const usage = useStore((s) => s.usage);
  const openaiUsage = useStore((s) => s.openaiUsage);
  const auth = useStore((s) => s.auth);
  const openaiAuth = useStore((s) => s.openaiAuth);
  const sessions = useStore((s) => s.sessions);
  const models = useStore((s) => s.models);
  const selectedSessionId = useStore((s) => s.selectedSessionId);

  // No login → no chip, independent of usage-message timing (also covers API-key users).
  const showClaude = Boolean(auth?.loggedIn && usage && usage.windows.length > 0);
  const showOpenai = Boolean(openaiAuth?.loggedIn && openaiUsage && openaiUsage.windows.length > 0);
  if (!showClaude && !showOpenai) return null;

  // Rollup over the sessions the store already holds — deleting a session drops
  // its spend, and a session that hasn't had a turn since `costByModel` existed
  // contributes nothing.
  const globalSpend = mergeSpend(Object.values(sessions).map((s) => s.costByModel));
  const selected = selectedSessionId ? sessions[selectedSessionId] : undefined;
  const sessionSpend = selected?.costByModel ?? {};
  // Marks are for telling two chips apart, so one chip wears none.
  const withMark = showClaude && showOpenai;

  return (
    <Group gap={2} wrap="nowrap">
      {showClaude && usage && (
        <PlanUsageChip
          provider="anthropic"
          usage={usage}
          title="Claude plan usage"
          accountLabel={auth?.account?.email ?? 'Signed in'}
          signOut={{ label: 'Log out', message: { type: 'authLogout' } }}
          globalRows={rowsFor(globalSpend, 'anthropic')}
          sessionRows={rowsFor(sessionSpend, 'anthropic')}
          models={models}
          withMark={withMark}
        />
      )}
      {showOpenai && openaiUsage && (
        <PlanUsageChip
          provider="openai"
          usage={openaiUsage}
          title="ChatGPT plan usage"
          accountLabel={openaiAuth?.account?.email ?? 'Connected to OpenAI'}
          signOut={{ label: 'Disconnect', message: { type: 'openaiLogout' } }}
          globalRows={rowsFor(globalSpend, 'openai')}
          sessionRows={rowsFor(sessionSpend, 'openai')}
          models={models}
          withMark={withMark}
        />
      )}
    </Group>
  );
}
