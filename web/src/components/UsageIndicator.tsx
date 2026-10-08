import { forwardRef, useState, type ComponentPropsWithoutRef } from 'react';
import {
  Accordion,
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  HoverCard,
  Menu,
  Popover,
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
  ResetCreditOutcome,
  UsageCredits,
  UsageSnapshot,
} from '@lines/shared';
import { useStore } from '../store';
import { consumeOpenaiResetCredit, send } from '../ws';
import { formatMinorCurrency, formatSpendUsd, formatTokens, usageColor } from '../lib/format';
import { useIsPhone } from '../lib/layout';
import { ProviderBadge } from './ProviderMark';

/** Anthropic names its windows with stable keys, so the label is a lookup. OpenAI
 *  reports only primary/secondary plus a duration, so its labels ride on the
 *  window itself (see UsageWindow.label). */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-hour limit',
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

/**
 * "Limit reached", and what happens next: credits take over, or the earliest
 * reset among the windows that are full.
 */
function LimitReachedLine({ usage }: { usage: UsageSnapshot }) {
  let detail: string | null = null;
  if (usage.credits?.enabled && !usage.credits.exhausted) {
    detail = 'using credits';
  } else {
    const full = usage.windows
      .filter((w) => w.utilization >= 100 && w.resetsAt)
      .sort((a, b) => new Date(a.resetsAt!).getTime() - new Date(b.resetsAt!).getTime());
    const resets = formatResetIn(full[0]?.resetsAt ?? null);
    if (resets) detail = resets.charAt(0).toLowerCase() + resets.slice(1);
    if (usage.credits?.exhausted) detail = detail ? `credits used up · ${detail}` : 'credits used up';
  }
  return (
    <Text size="xs" fw={600} c="red">
      Limit reached{detail ? ` — ${detail}` : ''}
    </Text>
  );
}

/**
 * Pay-as-you-go headroom past the windows. One component for both providers:
 * Claude's extra usage carries a monthly cap in minor units, OpenAI's credits a
 * balance — whichever fields are present decide what renders.
 */
function CreditsRow({ provider, credits }: { provider: ModelProvider; credits: UsageCredits }) {
  const name = provider === 'anthropic' ? 'Extra usage' : 'Credits';
  if (!credits.enabled) {
    return (
      <Text size="xs" c="dimmed">
        {name} · Off
      </Text>
    );
  }
  if (credits.unlimited) {
    return <Text size="xs">{name} · Unlimited</Text>;
  }
  if (credits.limitMinor !== undefined) {
    const used = credits.usedMinor ?? 0;
    const util = credits.utilization ?? (credits.limitMinor > 0 ? (used / credits.limitMinor) * 100 : 0);
    return (
      <div>
        <Group justify="space-between" gap="xs" mb={2}>
          <Text size="xs">{name}</Text>
          <Text size="xs" fw={600}>
            {Math.round(util)}%
          </Text>
        </Group>
        <Progress value={util} color={usageColor(util)} size="sm" />
        <Text size="xs" c="dimmed" mt={2}>
          {formatMinorCurrency(used, credits.currency)} of {formatMinorCurrency(credits.limitMinor, credits.currency)}{' '}
          this month
        </Text>
      </div>
    );
  }
  const messages =
    credits.approxLocalMessages !== undefined || credits.approxCloudMessages !== undefined
      ? `≈ ${credits.approxLocalMessages ?? 0} local / ${credits.approxCloudMessages ?? 0} cloud messages`
      : null;
  // A workspace's credits can arrive with no balance at all; say what is known
  // rather than print a bare heading.
  const state = credits.exhausted
    ? 'Used up'
    : credits.balance !== undefined
      ? `${credits.balance.toLocaleString()} remaining`
      : 'Available';
  return (
    <div>
      <Text size="xs" c={credits.exhausted ? 'red' : undefined}>
        {name} · {state}
      </Text>
      {messages && (
        <Text size="xs" c="dimmed">
          {messages}
        </Text>
      )}
    </div>
  );
}

const RESET_RESULT_COPY: Record<ResetCreditOutcome, string> = {
  reset: 'Limit reset.',
  nothingToReset: "Nothing to reset — you're under the limit. No credit was used.",
  noCredit: 'No reset credit is available on this account.',
  alreadyRedeemed: 'That reset credit was already redeemed.',
  error: 'The reset failed.',
};

/**
 * "N limit resets available", and the button that spends one.
 *
 * The confirmation is inline rather than a modal on purpose: a portaled modal
 * renders outside the hover card, which dismisses the card (see the Menu's
 * `withinPortal={false}` note). The result is shown in place for the same reason.
 */
function ResetCreditsRow({
  available,
  applicable,
  limitReached,
}: {
  available: number;
  /** Spendable now; undefined from a backend that does not say, which falls back to `available`. */
  applicable: number | undefined;
  limitReached: boolean;
}) {
  const usable = applicable ?? available;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const consume = async () => {
    setConfirming(false);
    setBusy(true);
    setResult(null);
    try {
      const { outcome, message } = await consumeOpenaiResetCredit();
      const text = outcome === 'error' && message ? message : RESET_RESULT_COPY[outcome];
      setResult({ ok: outcome === 'reset' || outcome === 'nothingToReset', text });
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap={4}>
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text size="xs" c="dimmed">
          {available} limit reset{available === 1 ? '' : 's'}{' '}
          {usable > 0 ? 'available' : 'saved — usable once you hit a limit'}
        </Text>
        {!confirming && usable > 0 && (
          <Button
            size="compact-xs"
            variant={limitReached ? 'filled' : 'subtle'}
            loading={busy}
            onClick={() => setConfirming(true)}
          >
            Reset limit
          </Button>
        )}
      </Group>
      {confirming && (
        <>
          <Text size="xs">
            Use 1 of {usable} reset credits to reset your Codex usage limit now? This can't be undone.
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button size="compact-xs" variant="default" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button size="compact-xs" color="red" onClick={() => void consume()}>
              Use a reset
            </Button>
          </Group>
        </>
      )}
      {result && (
        <Text size="xs" c={result.ok ? 'dimmed' : 'red'}>
          {result.text}
        </Text>
      )}
    </Stack>
  );
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
  /** Null while the provider is connected but no reading has arrived (or the last
   *  one was dropped) — the chip still renders, empty, rather than vanishing. */
  usage: UsageSnapshot | null;
  /** Dropdown heading, e.g. "Claude plan usage". */
  title: string;
  /** Account line at the foot of the dropdown; absent renders no footer. */
  accountLabel?: string;
  /** Copy and message for the footer's disconnect action. */
  signOut: { label: string; message: ClientMessage };
  /** The provider's own usage page, linked from the footer. */
  manageUrl?: { label: string; href: string };
  /** This provider's reset credits can be redeemed from the chip (OpenAI only). */
  canResetLimit?: boolean;
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
function PlanUsageChip(props: PlanUsageChipProps) {
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
        <UsageRing provider={props.provider} usage={props.usage} title={props.title} />
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <PlanUsageDetails {...props} />
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/** Primary window (the ring's value) and worst window (its colour) of a snapshot;
 *  null when there is no snapshot or it carries no windows. */
function ringWindows(usage: UsageSnapshot | null) {
  if (!usage || usage.windows.length === 0) return null;
  // A soft window has been seen past 100% without stopping anything, so it never
  // drives the ring — with OpenAI's 5-hour window soft, the weekly one does.
  const binding = usage.windows.filter((w) => !w.soft);
  const windows = binding.length > 0 ? binding : usage.windows;
  const worst = windows.reduce((a, b) => (b.utilization > a.utilization ? b : a), windows[0]);
  // Anthropic's session window by name where it exists, else simply the first —
  // OpenAI's primary window is already first (see parseOpenaiUsage).
  const primary = windows.find((w) => w.id === 'five_hour') ?? windows[0];
  return { primary, worst };
}

/**
 * The ring a chip opens from. Forwards its ref and props so it can be the
 * target of either a HoverCard or a Popover.
 */
const UsageRing = forwardRef<
  HTMLButtonElement,
  { provider: ModelProvider; usage: UsageSnapshot | null; title: string } & ComponentPropsWithoutRef<'button'>
>(function UsageRing({ provider, usage, title, ...button }, ref) {
  const ring = ringWindows(usage);
  return (
    <UnstyledButton
      {...button}
      ref={ref}
      aria-label={ring ? title : `${title} — no data yet`}
      style={{ display: 'flex', alignItems: 'center' }}
    >
      {/* Relative, so the badge can sit on the ring's corner without widening
          the button — both chips stay the same size either way. */}
      <Box style={{ position: 'relative', display: 'flex' }}>
        {/* No reading: same ring, empty, labelled with a dash — never `0`, which
            would read as "0% used". Same size, so nothing jumps when data lands. */}
        <RingProgress
          size={38}
          thickness={4}
          sections={
            ring
              ? [
                  {
                    value: ring.primary.utilization,
                    color: usage?.limitReached ? 'red' : usageColor(ring.worst.utilization),
                  },
                ]
              : []
          }
          label={
            <Text size="8px" ta="center" fw={700} c={ring ? undefined : 'dimmed'}>
              {ring ? Math.round(ring.primary.utilization) : '–'}
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
  );
});

/** A provider's plan windows, spend and account footer — the body of its chip. */
function PlanUsageDetails({
  provider,
  usage,
  title,
  hideTitle,
  accountLabel,
  signOut,
  manageUrl,
  canResetLimit,
  allTimeRows,
  periodRows,
  sessionRows,
  period,
  onPeriod,
  tzNote,
  models,
}: PlanUsageChipProps & { hideTitle?: boolean }) {
  const spendRows = period.g === 'all' ? allTimeRows : periodRows;
  // A deleted session leaves the rollup but not the ledger, so either side alone
  // is reason enough to show the section.
  const hasSpend = allTimeRows.length > 0 || periodRows.length > 0;
  // The chip's whole spend block, marked once at this level rather than per row:
  // every row under it belongs to this one provider, and `cost` asks exactly the
  // right question — "is a dollar figure here reported, or computed by us".
  const estimated = !capabilitiesFor(provider).cost;

  return (
    <Stack gap="xs">
      {(!hideTitle || usage?.plan) && (
        <Group justify="space-between" gap="xs" wrap="nowrap">
          {!hideTitle && (
            <Text size="xs" fw={700} tt="uppercase" c="dimmed">
              {title}
            </Text>
          )}
          {usage?.plan && (
            <Badge size="sm" variant="light" ml={hideTitle ? 'auto' : undefined}>
              {usage.plan}
            </Badge>
          )}
        </Group>
      )}
      {/* One generic line, not per-cause copy: the client cannot tell "first fetch
          pending" from "token rejected". The footer below stays — Disconnect and
          reconnect is the fix for a stale token. */}
      {!usage && (
        <Text size="xs" c="dimmed">
          Usage not available yet. Lines checks every 5 minutes.
        </Text>
      )}
      {usage?.limitReached && <LimitReachedLine usage={usage} />}
      {usage?.windows.map((w) => {
        const resets = formatResetIn(w.resetsAt);
        // Past 100% and not blocked: the window is not what limits this account.
        // OpenAI only — Claude's payload never says whether it is blocked, so an
        // absent `limitReached` there means "not told", not "allowed".
        const overButAllowed = provider === 'openai' && w.utilization >= 100 && !usage.limitReached;
        const note = w.soft
          ? 'Not enforced on this account — the weekly limit applies'
          : overButAllowed && usage.credits?.enabled && !usage.credits.exhausted
            ? 'Over the limit — continuing on credits'
            : null;
        return (
          <div key={w.id}>
            <Group justify="space-between" gap="xs" mb={2}>
              <Text size="xs" c={w.soft ? 'dimmed' : undefined}>
                {windowLabel(w.id, w.label)}
              </Text>
              <Text size="xs" fw={600} c={w.soft ? 'dimmed' : undefined}>
                {Math.round(w.utilization)}%
              </Text>
            </Group>
            <Progress
              value={w.utilization}
              color={w.soft || overButAllowed ? 'gray' : usageColor(w.utilization)}
              size="sm"
            />
            {note && (
              <Text size="xs" c="dimmed" mt={2}>
                {note}
              </Text>
            )}
            {resets && (
              <Text size="xs" c="dimmed" mt={2}>
                {resets}
              </Text>
            )}
          </div>
        );
      })}
      {usage?.credits && <CreditsRow provider={provider} credits={usage.credits} />}
      {canResetLimit && usage?.resetCreditsAvailable ? (
        <ResetCreditsRow
          available={usage.resetCreditsAvailable}
          applicable={usage.resetCreditsApplicable}
          limitReached={Boolean(usage.limitReached)}
        />
      ) : null}
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
      {usage && (
        <Text size="xs" c="dimmed">
          {formatAgo(usage.fetchedAt)}
        </Text>
      )}
      {accountLabel && (
        <>
          <Divider />
          <Group justify="space-between" gap="xs">
            <Text size="xs" c="dimmed" truncate>
              {accountLabel}
            </Text>
            <Group gap="sm" wrap="nowrap">
              {manageUrl && (
                <Anchor href={manageUrl.href} target="_blank" rel="noopener noreferrer" size="xs">
                  {manageUrl.label}
                </Anchor>
              )}
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
          </Group>
        </>
      )}
    </Stack>
  );
}

/** Spend keyed by model, narrowed to one provider's models. */
function rowsFor(spend: Record<string, ModelSpend>, provider: ModelProvider): [string, ModelSpend][] {
  return sortedSpend(spend).filter(([id]) => providerForModel(id) === provider);
}

/**
 * The plan-usage chips in the header — one per connected provider.
 *
 * Each renders only what its provider actually reports. A chip with no reading
 * yet (first fetch pending, failed, or a rejected token) shows an empty ring and
 * says so, rather than vanishing. A logged-out provider still gets no chip: this
 * is not a "connect OpenAI" affordance — Settings → Account owns that.
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
  const isPhone = useIsPhone();

  // Login alone decides the chip, independent of usage-message timing (no login
  // also covers API-key users). A missing or windowless snapshot renders empty.
  const showClaude = Boolean(auth?.loggedIn);
  const showOpenai = Boolean(openaiAuth?.loggedIn);
  if (!showClaude && !showOpenai) return null;
  const claudeData = usage && usage.windows.length > 0 ? usage : null;
  const openaiData = openaiUsage && openaiUsage.windows.length > 0 ? openaiUsage : null;

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

  const shared = { period, onPeriod: setPeriod, tzNote, models };
  const chips: PlanUsageChipProps[] = [];
  if (showClaude) {
    chips.push({
      provider: 'anthropic',
      usage: claudeData,
      title: 'Claude plan usage',
      accountLabel: auth?.account?.email ?? 'Connected to Claude',
      signOut: { label: 'Disconnect', message: { type: 'authLogout' } },
      manageUrl: { label: 'Manage usage', href: 'https://claude.ai/settings/usage' },
      allTimeRows: rowsFor(globalSpend, 'anthropic'),
      periodRows: rowsFor(periodSpend, 'anthropic'),
      sessionRows: rowsFor(sessionSpend, 'anthropic'),
      ...shared,
    });
  }
  if (showOpenai) {
    chips.push({
      provider: 'openai',
      usage: openaiData,
      title: 'ChatGPT plan usage',
      accountLabel: openaiAuth?.account?.email ?? 'Connected to OpenAI',
      signOut: { label: 'Disconnect', message: { type: 'openaiLogout' } },
      manageUrl: { label: 'Manage usage', href: 'https://chatgpt.com/codex/settings/usage' },
      canResetLimit: true,
      allTimeRows: rowsFor(globalSpend, 'openai'),
      periodRows: rowsFor(periodSpend, 'openai'),
      sessionRows: rowsFor(sessionSpend, 'openai'),
      ...shared,
    });
  }

  // A phone has no room for a ring per provider, so it shows one.
  if (isPhone && chips.length > 1) return <GroupedUsageChip chips={chips} />;

  return (
    <Group gap={2} wrap="nowrap">
      {chips.map((chip) => (
        <PlanUsageChip key={chip.provider} {...chip} />
      ))}
    </Group>
  );
}

/**
 * Every provider behind one ring, for a phone: the ring is the provider with
 * the least left — its worst window is the one that stops work first — and a
 * tap opens each provider's details in an accordion. A Popover rather than a
 * HoverCard, since a touchscreen has no hover.
 */
function GroupedUsageChip({ chips }: { chips: PlanUsageChipProps[] }) {
  // -1 for an empty chip, so any chip with a reading wins the ring; when all are
  // empty, the ring renders empty.
  const worstOf = (chip: PlanUsageChipProps) => ringWindows(chip.usage)?.worst.utilization ?? -1;
  const tightest = chips.reduce((a, b) => (worstOf(b) > worstOf(a) ? b : a));
  return (
    <Popover width="min(340px, calc(100vw - 2rem))" position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <UsageRing provider={tightest.provider} usage={tightest.usage} title="Plan usage" />
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <Accordion defaultValue={tightest.provider}>
          {chips.map((chip) => (
            <Accordion.Item key={chip.provider} value={chip.provider}>
              <Accordion.Control>
                <Group gap="xs" wrap="nowrap" justify="space-between" pr="xs">
                  <Text size="xs" fw={700} tt="uppercase" c="dimmed">
                    {chip.title}
                  </Text>
                  {chip.usage ? (
                    <Text size="xs" fw={600} c={usageColor(worstOf(chip))}>
                      {Math.round(worstOf(chip))}%
                    </Text>
                  ) : (
                    <Text size="xs" fw={600} c="dimmed">
                      –
                    </Text>
                  )}
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <PlanUsageDetails {...chip} hideTitle />
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      </Popover.Dropdown>
    </Popover>
  );
}
