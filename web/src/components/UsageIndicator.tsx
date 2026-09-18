import { useState } from 'react';
import {
  ActionIcon,
  Anchor,
  Box,
  Divider,
  Group,
  HoverCard,
  Menu,
  Progress,
  RingProgress,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { IconChevronDown, IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import {
  capabilitiesFor,
  dayKey,
  foldDays,
  mergeSpend,
  periodBounds,
  periodLabel,
  providerForModel,
  shiftPeriod,
  sortedSpend,
} from '@lines/shared';
import type {
  ClientMessage,
  Granularity,
  ModelOption,
  ModelProvider,
  ModelSpend,
  UsageSnapshot,
} from '@lines/shared';
import { useStore } from '../store';
import { send } from '../ws';
import { formatSpendUsd, formatTokens, usageColor } from '../lib/format';
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
 * `$0.00`: a turn can report tokens and no USD at all (an unpriced model, or a
 * row recorded before estimates existed), so a column of zeroes would read as
 * "these turns were free" instead of "we are not told".
 *
 * `estimated` is a property of the whole block rather than of a row: every spend
 * surface here is already narrowed to one provider by `rowsFor`, so either all
 * of these figures are computed or none are.
 */
function SpendRows({
  rows,
  models,
  estimated,
}: {
  rows: [string, ModelSpend][];
  models: ModelOption[];
  estimated: boolean;
}) {
  return (
    <>
      {rows.map(([id, spend]) => (
        <Group key={id} justify="space-between" gap="xs">
          <Text size="xs" truncate>
            {modelLabel(id, models)}
          </Text>
          <Text size="xs" c="dimmed">
            {spend.costUsd > 0 ? `${formatSpendUsd(spend.costUsd, estimated)} · ` : ''}
            {formatTokens(spend.tokens)}
          </Text>
        </Group>
      ))}
    </>
  );
}

/**
 * Which period the spend table is showing. `anchor` is any day key inside it —
 * the bounds are derived, so paging is one date shift rather than a range.
 *
 * Ephemeral UI state, deliberately not in zustand: it is lifted only as far as
 * `UsageIndicator` so the two provider chips page in lockstep, and nothing
 * outside the dropdown has any business reading it.
 */
interface Period {
  g: Granularity;
  anchor: string;
}

const GRANULARITIES: { value: Granularity; label: string }[] = [
  // All first and default: it is the only figure that spans machines, and it is
  // the number this card already showed — upgrading must not silently change
  // what the user is reading.
  { value: 'all', label: 'All time' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

function totalOf(rows: [string, ModelSpend][]): ModelSpend {
  return rows.reduce(
    (acc, [, spend]) => ({
      costUsd: acc.costUsd + spend.costUsd,
      tokens: acc.tokens + spend.tokens,
      turns: acc.turns + spend.turns,
    }),
    { costUsd: 0, tokens: 0, turns: 0 },
  );
}

/**
 * Segment picker, period pager and the rows for whichever period is selected.
 *
 * Rendered per provider (so each chip accounts for its own models) but driven by
 * one `Period` owned above, so the two never disagree about which week is on
 * screen.
 */
function SpendSection({
  rows,
  period,
  onPeriod,
  models,
  estimated,
  tzNote,
}: {
  rows: [string, ModelSpend][];
  period: Period;
  onPeriod: (next: Period) => void;
  models: ModelOption[];
  /** This provider reports no cost, so every figure here is computed from a
   *  price table rather than billed — see shared/estimateSpend.ts. */
  estimated: boolean;
  /** The bridge's timezone when it disagrees with this browser's; null when it
   *  matches or is unknown. Day keys are frozen at write time, so a mismatch is
   *  reported rather than re-bucketed. */
  tzNote: string | null;
}) {
  const { g, anchor } = period;
  const total = totalOf(rows);
  // Nothing to page forward into: this period already contains today.
  const atLatest = periodBounds(anchor, g).to >= dayKey(Date.now());

  return (
    <>
      <Divider />
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text size="xs" fw={700} tt="uppercase" c="dimmed">
          Spend by model
        </Text>
        {/* `withinPortal={false}` is load-bearing, not a preference: a portaled
            dropdown renders outside the hover card, so moving the pointer onto it
            counts as leaving the card and dismisses both. Kept inside, the menu
            is part of what the card considers itself. */}
        <Menu position="bottom-end" width={120} withinPortal={false}>
          <Menu.Target>
            <UnstyledButton aria-label="Change period" c="dimmed">
              <Group gap={2} wrap="nowrap">
                <Text size="xs" c="inherit">
                  {GRANULARITIES.find((s) => s.value === g)?.label}
                </Text>
                <IconChevronDown size={12} />
              </Group>
            </UnstyledButton>
          </Menu.Target>
          <Menu.Dropdown>
            {GRANULARITIES.map((segment) => (
              <Menu.Item
                key={segment.value}
                fz="xs"
                fw={segment.value === g ? 600 : undefined}
                // Re-anchored on today, so switching granularity never lands the
                // user in a period they did not navigate to.
                onClick={() => onPeriod({ g: segment.value, anchor: dayKey(Date.now()) })}
              >
                {segment.label}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Group>
      {g !== 'all' && (
        <Group justify="space-between" gap={4} wrap="nowrap">
          <ActionIcon
            size="sm"
            variant="subtle"
            aria-label="Previous period"
            onClick={() => onPeriod({ g, anchor: shiftPeriod(anchor, g, -1) })}
          >
            <IconChevronLeft size={14} />
          </ActionIcon>
          <Text size="xs" fw={600}>
            {periodLabel(anchor, g)}
          </Text>
          <ActionIcon
            size="sm"
            variant="subtle"
            aria-label="Next period"
            disabled={atLatest}
            onClick={() => onPeriod({ g, anchor: shiftPeriod(anchor, g, 1) })}
          >
            <IconChevronRight size={14} />
          </ActionIcon>
        </Group>
      )}
      {/* No reserved height: the card is anchored at its top and the pager sits
          above this block, so a period with fewer rows shortens the card without
          moving anything the pointer is aimed at. */}
      {rows.length > 0 ? (
        <SpendRows rows={rows} models={models} estimated={estimated} />
      ) : (
        <Text size="xs" c="dimmed">
          No spend in this period.
        </Text>
      )}
      {/* A rule and a right-aligned figure, no "Total" label: it lands in the same
          column as every row's amount above it, which is what says what it is. */}
      <Divider />
      <Text size="xs" fw={600} ta="right">
        {total.costUsd > 0 ? `${formatSpendUsd(total.costUsd, estimated)} · ` : ''}
        {formatTokens(total.tokens)}
      </Text>
      {/* Said once, here, for every `~` on this chip — the tilde alone marks the
          figure as computed but cannot say what it is computed against. Not
          gated on the period: the caveat holds for all of them. */}
      {estimated && (
        <Text size="xs" c="dimmed">
          ~ estimated from token counts at API list prices. This plan is flat-rate, so it is not
          what you were billed.
        </Text>
      )}
      {g !== 'all' && (
        <Text size="xs" c="dimmed">
          This machine only{tzNote ? ` · days counted in ${tzNote}` : ''}
        </Text>
      )}
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
  /** All-time rollup for this provider's models only — each chip accounts for
   *  its own. Derived from the synced sessions, so it spans machines. */
  allTimeRows: [string, ModelSpend][];
  /** The same, folded out of this machine's day ledger for the selected period. */
  periodRows: [string, ModelSpend][];
  sessionRows: [string, ModelSpend][];
  period: Period;
  onPeriod: (next: Period) => void;
  tzNote: string | null;
  models: ModelOption[];
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
  allTimeRows,
  periodRows,
  sessionRows,
  period,
  onPeriod,
  tzNote,
  models,
}: PlanUsageChipProps) {
  const spendRows = period.g === 'all' ? allTimeRows : periodRows;
  // A deleted session leaves the rollup but not the ledger, so either side alone
  // is reason enough to show the section.
  const hasSpend = allTimeRows.length > 0 || periodRows.length > 0;
  // The chip's whole spend block, marked once at this level rather than per row:
  // every row under it belongs to this one provider, and `cost` asks exactly the
  // right question — "is a dollar figure here reported, or computed by us".
  const estimated = !capabilitiesFor(provider).cost;
  const worst = usage.windows.reduce((a, b) => (b.utilization > a.utilization ? b : a), usage.windows[0]);
  // Anthropic's session window by name where it exists, else simply the first —
  // OpenAI's primary window is already first (see parseOpenaiUsage).
  const primary = usage.windows.find((w) => w.id === 'five_hour') ?? usage.windows[0];

  return (
    // Wider than the plan-usage windows alone need: the spend heading now shares
    // its line with the period picker, and the pager's label has to fit between
    // its two arrows, both without wrapping.
    <HoverCard
      width="min(340px, calc(100vw - 2rem))"
      position="bottom-end"
      withArrow
      shadow="md"
      openDelay={100}
      closeDelay={100}
    >
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
            {/* Always, not only when a second provider is connected: which vendor a
                number belongs to is part of reading it, and a mark that comes and
                goes teaches nothing. It also keeps the chip's appearance stable
                when the other provider is connected or disconnected. */}
            <ProviderBadge provider={provider} />
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
          {hasSpend && (
            <>
              <SpendSection
                rows={spendRows}
                period={period}
                onPeriod={onPeriod}
                models={models}
                estimated={estimated}
                tzNote={tzNote}
              />
              {/* A single-model session adds nothing over the sidebar's own total. */}
              {sessionRows.length > 1 && (
                <>
                  <Text size="xs" fw={700} tt="uppercase" c="dimmed">
                    This session
                  </Text>
                  <SpendRows rows={sessionRows} models={models} estimated={estimated} />
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
  const spendHistory = useStore((s) => s.spendHistory);
  // One period for both chips, so they page together. Above the early return on
  // purpose: a hook placed after it would break hook order.
  const [period, setPeriod] = useState<Period>({ g: 'all', anchor: dayKey(Date.now()) });

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

  // The period total comes from this machine's ledger instead, folded over the
  // day keys the selected period spans. `all` never reads it: the rollup above
  // is the only cross-machine figure and stays the default for that reason.
  const bounds = periodBounds(period.anchor, period.g);
  const periodSpend = foldDays(spendHistory?.days ?? {}, bounds.from, bounds.to);
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzNote = spendHistory?.tz && spendHistory.tz !== browserTz ? spendHistory.tz : null;

  return (
    <Group gap={2} wrap="nowrap">
      {showClaude && usage && (
        <PlanUsageChip
          provider="anthropic"
          usage={usage}
          title="Claude plan usage"
          accountLabel={auth?.account?.email ?? 'Signed in'}
          signOut={{ label: 'Log out', message: { type: 'authLogout' } }}
          allTimeRows={rowsFor(globalSpend, 'anthropic')}
          periodRows={rowsFor(periodSpend, 'anthropic')}
          sessionRows={rowsFor(sessionSpend, 'anthropic')}
          period={period}
          onPeriod={setPeriod}
          tzNote={tzNote}
          models={models}
        />
      )}
      {showOpenai && openaiUsage && (
        <PlanUsageChip
          provider="openai"
          usage={openaiUsage}
          title="ChatGPT plan usage"
          accountLabel={openaiAuth?.account?.email ?? 'Connected to OpenAI'}
          signOut={{ label: 'Disconnect', message: { type: 'openaiLogout' } }}
          allTimeRows={rowsFor(globalSpend, 'openai')}
          periodRows={rowsFor(periodSpend, 'openai')}
          sessionRows={rowsFor(sessionSpend, 'openai')}
          period={period}
          onPeriod={setPeriod}
          tzNote={tzNote}
          models={models}
        />
      )}
    </Group>
  );
}
