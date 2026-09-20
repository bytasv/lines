import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Collapse,
  Divider,
  Group,
  HoverCard,
  Loader,
  Progress,
  RingProgress,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useHover } from '@mantine/hooks';
import { IconAlertTriangle, IconChevronRight } from '@tabler/icons-react';
import type {
  ContextBreakdown,
  ContextCategory,
  ContextSummary,
  ContextUsage,
  SessionMeta,
} from '@lines/shared';
import {
  CONTEXT_WARN_PCT,
  contextCompactBlock,
  contextDenominator,
  effectiveContextTokens,
  hasEstimatedSpend,
  preferContextSummary,
} from '@lines/shared';
import { sessionCaps } from '../lib/capabilities';
import { useStore } from '../store';
import { useSessionMachineHealth } from '../lib/can';
import { useReveal } from '../lib/layout';
import { send } from '../ws';
import { formatDuration, formatSpendUsd, formatTokens, usageColor } from '../lib/format';

/** Category name as a lookup key: lowercased, with a trailing ` (deferred)`
 *  stripped, so a deferred row shares its category's colour and detail. */
function categoryKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s*\(deferred\)$/, '');
}

/** Verified CLI category names -> Mantine colors; anything unrecognised stays gray. */
const CATEGORY_COLORS: Record<string, string> = {
  'system prompt': 'violet',
  'system tools': 'blue',
  'mcp tools': 'cyan',
  'custom agents': 'grape',
  'memory files': 'orange',
  skills: 'lime',
  'slash commands': 'yellow',
  messages: 'teal',
  'autocompact buffer': 'gray',
  'compact buffer': 'gray',
  'free space': 'dark.3',
};

/** Width of a row's leading marker slot: holds the colour dot, or the expand
 *  chevron in its place while the row is hovered or open. One slot for both keeps
 *  every category name on the same left edge, expandable or not. */
const MARKER_W = 14;
const ROW_GAP = 8;
const PERCENT_W = 38;

/** Deferred rows render a lighter shade — they don't count against the window. */
function categoryColor(name: string, deferred?: boolean): string {
  const base = CATEGORY_COLORS[categoryKey(name)] ?? 'gray';
  if (!deferred) return base;
  return base.includes('.') ? base : `${base}.3`;
}

function TotalRow({ label, value, dim }: { label: string; value: string; dim?: string }) {
  return (
    <Group justify="space-between" gap="xs" wrap="nowrap">
      <Text size="xs" c="dimmed">
        {label}
        {dim && (
          <Text span size="xs" c="dimmed" fs="italic">
            {' '}
            {dim}
          </Text>
        )}
      </Text>
      <Text size="xs" fw={600}>
        {value}
      </Text>
    </Group>
  );
}

/** Detail line inside an expanded category, indented past the marker slot so it
 *  starts under the category name. */
function DetailRow({ label, hint, tokens }: { label: string; hint?: string; tokens: number }) {
  // pr reserves the category rows' percent column, so token values share a right edge.
  return (
    <Group justify="space-between" gap="xs" wrap="nowrap" pl={MARKER_W + ROW_GAP} pr={PERCENT_W + ROW_GAP}>
      <Text size="xs" c="dimmed" truncate>
        {label}
        {hint && (
          <Text span size="xs" c="dimmed" opacity={0.6}>
            {' '}
            {hint}
          </Text>
        )}
      </Text>
      <Text size="xs" c="dimmed">
        {formatTokens(tokens)}
      </Text>
    </Group>
  );
}

/** Lists over this many rows scroll instead of growing the card. */
const SCROLL_AFTER = 8;

function DetailList({ children, count }: { children: React.ReactNode; count: number }) {
  if (count <= SCROLL_AFTER) return <Stack gap={2}>{children}</Stack>;
  return (
    <ScrollArea.Autosize mah={180} type="auto">
      <Stack gap={2}>{children}</Stack>
    </ScrollArea.Autosize>
  );
}

/**
 * Per-item detail for one category, or null when this category has none. Keyed
 * off which detail array exists rather than off the label alone, so a CLI
 * category rename loses the styling but not the data.
 */
function categoryDetail(
  key: string,
  deferred: boolean,
  b: ContextBreakdown,
): React.ReactNode | null {
  if (deferred) {
    if (key === 'mcp tools') {
      const unloaded = b.mcpServers.flatMap((s) =>
        s.tools.filter((t) => t.loaded === false).map((t) => ({ ...t, server: s.serverName })),
      );
      if (!unloaded.length) return null;
      return (
        <DetailList count={unloaded.length}>
          {unloaded.map((t) => (
            <DetailRow key={`${t.server}/${t.name}`} label={t.name} hint={t.server} tokens={t.tokens} />
          ))}
        </DetailList>
      );
    }
    if (!b.deferredTools.length) return null;
    return (
      <DetailList count={b.deferredTools.length}>
        {b.deferredTools.map((t) => (
          <DetailRow key={t.name} label={t.name} tokens={t.tokens} />
        ))}
      </DetailList>
    );
  }
  switch (key) {
    case 'mcp tools':
      if (!b.mcpServers.length) return null;
      return (
        <DetailList count={b.mcpServers.length}>
          {b.mcpServers.map((s) => (
            <DetailRow key={s.serverName} label={s.serverName} hint={`${s.toolCount} tools`} tokens={s.tokens} />
          ))}
        </DetailList>
      );
    case 'memory files':
      if (!b.memoryFiles.length) return null;
      return (
        <DetailList count={b.memoryFiles.length}>
          {b.memoryFiles.map((f) => (
            <DetailRow
              key={f.path}
              label={f.path.split('/').pop() ?? f.path}
              hint={f.type}
              tokens={f.tokens}
            />
          ))}
        </DetailList>
      );
    case 'custom agents':
      if (!b.agents.length) return null;
      return (
        <DetailList count={b.agents.length}>
          {b.agents.map((a) => (
            <DetailRow key={a.agentType} label={a.agentType} hint={a.source} tokens={a.tokens} />
          ))}
        </DetailList>
      );
    case 'system tools':
      if (!b.systemTools.length) return null;
      return (
        <DetailList count={b.systemTools.length}>
          {b.systemTools.map((t) => (
            <DetailRow key={t.name} label={t.name} tokens={t.tokens} />
          ))}
        </DetailList>
      );
    case 'system prompt':
      if (!b.systemPromptSections.length) return null;
      return (
        <DetailList count={b.systemPromptSections.length}>
          {b.systemPromptSections.map((s) => (
            <DetailRow key={s.name} label={s.name} tokens={s.tokens} />
          ))}
        </DetailList>
      );
    case 'skills': {
      const items = b.skills?.items ?? [];
      if (!items.length) return null;
      return (
        <DetailList count={items.length}>
          {items.map((s) => (
            <DetailRow key={s.name} label={s.name} hint={s.source} tokens={s.tokens} />
          ))}
        </DetailList>
      );
    }
    case 'messages': {
      const m = b.messages;
      if (!m) return null;
      const rows: [string, number][] = [
        ['Tool calls', m.toolCalls],
        ['Tool results', m.toolResults],
        ['Attachments', m.attachments],
        ['Assistant', m.assistant],
        ['User', m.user],
        ['Other', m.other],
      ];
      return (
        <Stack gap={2}>
          {rows.map(([label, tokens]) => (
            <DetailRow key={label} label={label} tokens={tokens} />
          ))}
        </Stack>
      );
    }
    default:
      return null;
  }
}

/**
 * One category row. Expandable rows swap their colour dot for a chevron on
 * hover instead of adding a column, so rows with and without detail align.
 */
function CategoryRow({
  category,
  percent,
  detail,
  expanded,
  onToggle,
}: {
  category: ContextCategory;
  /** null for deferred rows — they aren't in the window, so a share of it would lie. */
  percent: number | null;
  detail: React.ReactNode | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { hovered, ref } = useHover<HTMLDivElement>();
  // On touch the chevron is the only sign a row can be expanded at all, so it is
  // shown outright there rather than waiting for a hover that never arrives.
  const show = useReveal(hovered);
  const showChevron = detail != null && (show || expanded);

  const row = (
    <Group justify="space-between" gap={ROW_GAP} wrap="nowrap">
      <Group gap={ROW_GAP} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
        <Box
          w={MARKER_W}
          h={MARKER_W}
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {showChevron ? (
            <IconChevronRight
              size={12}
              style={{
                transform: expanded ? 'rotate(90deg)' : undefined,
                transition: 'transform 150ms',
              }}
            />
          ) : (
            <Box
              w={8}
              h={8}
              bg={categoryColor(category.name, category.deferred)}
              style={{ borderRadius: 2 }}
            />
          )}
        </Box>
        <Text size="xs" truncate c={category.deferred ? 'dimmed' : undefined}>
          {category.name}
        </Text>
      </Group>
      <Text size="xs" fw={600}>
        {formatTokens(category.tokens)}
      </Text>
      <Text size="xs" c="dimmed" w={PERCENT_W} ta="right">
        {percent == null ? '—' : `${percent.toFixed(1)}%`}
      </Text>
    </Group>
  );

  return (
    <div
      ref={ref}
      style={{
        borderRadius: 4,
        background: detail && hovered ? 'var(--mantine-color-default-hover)' : undefined,
      }}
    >
      {detail ? (
        <UnstyledButton onClick={onToggle} style={{ width: '100%', display: 'block' }}>
          {row}
        </UnstyledButton>
      ) : (
        row
      )}
      {detail && (
        <Collapse expanded={expanded} transitionDuration={150}>
          <Box mt={2} mb={4}>
            {detail}
          </Box>
        </Collapse>
      )}
    </div>
  );
}

/** SDK breakdown body: stacked bar, category rows with expandable detail, totals. */
function BreakdownBody({
  view,
  breakdown,
  open,
  toggle,
}: {
  view: ContextSummary;
  breakdown: ContextBreakdown | null;
  open: Set<string>;
  toggle: (key: string) => void;
}) {
  // 'Free space' is derived, never a row: the live payload includes it, the
  // persisted summary drops it, and both must render the same way.
  const rows = view.categories.filter((c) => categoryKey(c.name) !== 'free space' && c.tokens > 0);
  const free = Math.max(0, view.maxTokens - view.totalTokens);
  const pctOf = (tokens: number) => (view.maxTokens > 0 ? (tokens / view.maxTokens) * 100 : 0);

  return (
    <>
      <Progress.Root size="sm">
        {rows
          .filter((c) => !c.deferred)
          .map((c) => (
            <Progress.Section key={c.name} value={pctOf(c.tokens)} color={categoryColor(c.name)} />
          ))}
      </Progress.Root>
      <Stack gap={2}>
        {rows.map((c) => (
          <CategoryRow
            key={c.name}
            category={c}
            percent={c.deferred ? null : pctOf(c.tokens)}
            detail={breakdown ? categoryDetail(categoryKey(c.name), c.deferred === true, breakdown) : null}
            expanded={open.has(c.name)}
            onToggle={() => toggle(c.name)}
          />
        ))}
      </Stack>
      <Divider />
      <TotalRow label="Total in context" value={`${formatTokens(view.totalTokens)} · ${Math.round(view.percentage)}%`} />
      <TotalRow label="Free space" value={formatTokens(free)} />
      <TotalRow
        label="Window"
        value={formatTokens(view.maxTokens)}
        dim={view.rawMaxTokens && view.rawMaxTokens !== view.maxTokens ? `of ${formatTokens(view.rawMaxTokens)} raw` : undefined}
      />
      <AutoCompactRow view={view} />
    </>
  );
}

/**
 * Auto-compaction is the CLI's, not ours — Lines never sets `autoCompactEnabled`,
 * it only reports whatever the CLI resolved. Shown even when off, so "it never
 * fires" reads as a setting rather than a missing row, and with the headroom left
 * so "on but never reached" is distinguishable too.
 */
function AutoCompactRow({ view }: { view: ContextSummary }) {
  if (view.isAutoCompactEnabled === false) return <TotalRow label="CLI auto-compact" value="off" />;
  if (!view.isAutoCompactEnabled || view.autoCompactThreshold == null) return null;
  const toGo = view.autoCompactThreshold - view.totalTokens;
  return (
    <TotalRow
      label="CLI auto-compacts at"
      value={formatTokens(view.autoCompactThreshold)}
      dim={toGo > 0 ? `${formatTokens(toGo)} to go` : undefined}
    />
  );
}

/**
 * Manual compaction trigger. Disabled in several legitimately different
 * situations, so it always states which one — the tooltip text is the shared
 * predicate's own `reason`, the same string the server rejects with.
 */
function CompactButton({ session }: { session: SessionMeta }) {
  const block = contextCompactBlock(session);
  return (
    <Tooltip
      label={block?.reason ?? "Compact this session's context now"}
      multiline
      w={240}
      withArrow
      position="top"
    >
      {/* Wrapper: a disabled Mantine button swallows the pointer events the
          tooltip needs, and a disabled button with no explanation is the thing
          this is meant to avoid. */}
      <Box>
        <Button
          size="compact-xs"
          variant="light"
          fullWidth
          disabled={block !== null}
          title={block?.reason ?? "Compact this session's context now"}
          onClick={() => send({ type: 'compactContext', sessionId: session.id })}
        >
          Compact now
        </Button>
      </Box>
    </Tooltip>
  );
}

/** Assistant-usage body — the reading we can derive without a live query. */
function FallbackBody({ usage }: { usage: ContextUsage }) {
  const promptSum = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const residual = usage.reportedTotal != null ? usage.reportedTotal - promptSum : 0;
  const used = promptSum + usage.outputTokens;
  const rows: [string, number][] = [
    ['Fresh input', usage.inputTokens],
    ['Cache read', usage.cacheReadTokens],
    ['Cache write', usage.cacheCreationTokens],
    ['Output', usage.outputTokens],
  ];
  return (
    <>
      <Stack gap={2}>
        {rows.map(([label, value]) => (
          <Group key={label} justify="space-between" gap="xs">
            <Text size="xs">{label}</Text>
            <Text size="xs" fw={600}>
              {formatTokens(value)}
            </Text>
          </Group>
        ))}
      </Stack>
      <Divider />
      <TotalRow label="Total in context" value={formatTokens(used)} />
      {residual !== 0 && (
        <TotalRow label="Unaccounted" value={`${residual > 0 ? '+' : '−'}${formatTokens(Math.abs(residual))}`} />
      )}
    </>
  );
}

/**
 * Context occupancy for the session's last settled turn — distinct from the
 * cumulative spend shown next to it. Prefers the SDK's `/context` breakdown
 * (categories + per-item detail, fetched live on hover) and falls back to the
 * assistant-message usage when no live query can be asked. Renders nothing until
 * a turn has produced a reading.
 */
export function ContextWindowIndicator({
  session,
  inline = false,
}: {
  session: SessionMeta;
  inline?: boolean;
}) {
  const models = useStore((s) => s.models);
  const entry = useStore((s) => s.contextBreakdowns[session.id]);
  const requestContextBreakdown = useStore((s) => s.requestContextBreakdown);
  const health = useSessionMachineHealth(session.id);
  const hasReading = Boolean(session.contextSummary || session.contextUsage);
  useEffect(() => {
    if (
      inline && hasReading && health.connected && health.bridgeAttached &&
      sessionCaps(session).contextWindow
    ) {
      requestContextBreakdown(session.id);
    }
  }, [
    inline, hasReading, health.connected, health.bridgeAttached,
    session.id, session.model, requestContextBreakdown,
  ]);
  // Expansion state must live here, not in the dropdown: HoverCard unmounts its
  // dropdown on close, which would reset it every time the pointer leaves.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // Hidden outright where the engine reports no occupancy, and deliberately
  // rather than incidentally: there is no reading to show and no compaction to
  // offer from this card, and a ring that could never fill reads as broken.
  if (!sessionCaps(session).contextWindow) return null;

  const summary = session.contextSummary;
  const usage = session.contextUsage;
  if (!summary && !usage) return null;
  const sdkMode = preferContextSummary(summary, usage);

  // The live payload wins when it is at least as fresh as the persisted summary —
  // a hover that predates the last turn's refresh must not un-update the card.
  const live = entry?.breakdown ?? undefined;
  const view: ContextSummary | undefined = sdkMode
    ? live && (!summary || live.at >= summary.at)
      ? live
      : summary
    : undefined;
  // A fresh-start workflow step discards the CLI conversation, so any earlier
  // reading describes something that no longer exists.
  const readingAt = view?.at ?? usage?.at ?? 0;
  const stale = session.contextResetAt != null && readingAt < session.contextResetAt;
  const model = view?.model ?? usage?.model ?? session.model;
  // `usage` is passed so a window the provider reported wins over our table —
  // codex names its own per thread, and it is the one the numerator came from.
  const denominator = contextDenominator(sdkMode ? summary : undefined, model, models, usage);
  const fallbackUsed = usage
    ? usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens + usage.outputTokens
    : 0;
  // A compaction that landed after the last reading supersedes both bodies: the
  // categories below describe a conversation that has since been summarized away.
  const effective = effectiveContextTokens(session);
  const compacted = effective?.fromCompaction ? effective.used : null;
  // The CLI's real window when we have ever seen one, even in fallback mode —
  // a compaction reports raw tokens, so it needs a denominator of its own.
  const windowTokens = contextDenominator(summary, model, models, usage);
  const pct =
    compacted != null
      ? windowTokens
        ? Math.min(100, (compacted / windowTokens) * 100)
        : null
      : view
        ? Math.min(100, view.percentage)
        : denominator
          ? Math.min(100, (fallbackUsed / denominator) * 100)
          : null;
  const nearLimit = !stale && pct != null && pct >= CONTEXT_WARN_PCT;
  const modelLabel = models.find((m) => m.id === model)?.label ?? model;

  const content = (
    <Stack gap="xs">
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Group gap={6} wrap="nowrap">
          <Text size="xs" fw={700} tt="uppercase" c="dimmed">
            Context window
          </Text>
          {entry?.loading && <Loader size={10} />}
        </Group>
        <Text size="xs" c="dimmed" truncate>
          {modelLabel}
        </Text>
      </Group>
      {view ? (
        <BreakdownBody
          view={view}
          breakdown={entry?.breakdown ?? null}
          open={open}
          toggle={toggle}
        />
      ) : (
        usage && <FallbackBody usage={usage} />
      )}
      {entry && !entry.loading && !entry.breakdown && (
        <Text size="xs" c="dimmed">
          Live detail unavailable — the session isn't running.
        </Text>
      )}
      {compacted != null && (
        <Text size="xs" c="dimmed">
          {session.contextCompact?.trigger === 'auto'
            ? 'Auto-compacted since the last measured turn'
            : 'Compacted since the last measured turn'}
          {` — ${formatTokens(compacted)} in context. The breakdown above predates it.`}
        </Text>
      )}
      <Text size="xs" c="dimmed">
        {stale
          ? 'The conversation was reset for a fresh step — this reading is from before that, and refreshes when the next turn completes.'
          : 'Measured at the last completed turn; the draft you are typing is not counted.'}
      </Text>
      {nearLimit && (
        <Group gap={6} wrap="nowrap">
          <IconAlertTriangle size={12} color="var(--mantine-color-orange-6)" />
          <Text size="xs" c="orange">
            Over {CONTEXT_WARN_PCT}% of the window — compacting now frees room for the rest of the
            task.
          </Text>
        </Group>
      )}
      <CompactButton session={session} />
      <Divider />
      <Text size="xs" fw={700} tt="uppercase" c="dimmed">
        Session totals
      </Text>
      {session.totalTokens != null && (
        <TotalRow
          label="Tokens"
          dim="(cumulative spend, not context)"
          value={formatTokens(session.totalTokens)}
        />
      )}
      {session.totalCostUsd != null && (
        <TotalRow
          label="Cost"
          value={formatSpendUsd(session.totalCostUsd, hasEstimatedSpend(session.costByModel), 3)}
        />
      )}
      {session.totalDurationMs != null && (
        <TotalRow label="Active time" value={formatDuration(session.totalDurationMs)} />
      )}
    </Stack>
  );
  if (inline) return content;

  return (
    <HoverCard
      width="min(340px, calc(100vw - 2rem))"
      position="top-end"
      withArrow
      shadow="md"
      openDelay={100}
      closeDelay={150}
      onOpen={() => requestContextBreakdown(session.id)}
    >
      <HoverCard.Target>
        <UnstyledButton
          aria-label="Context window usage"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            opacity: stale ? 0.45 : 1,
          }}
        >
          {pct == null ? (
            <Text size="xs" c="dimmed">
              {formatTokens(fallbackUsed)} ctx
            </Text>
          ) : (
            // Bare ring, no label — the percentage lives in the hover card. A stale
            // reading drops its colour too, so it can't read as a live measurement.
            <RingProgress
              size={18}
              thickness={2}
              sections={[{ value: pct, color: stale ? 'gray' : usageColor(pct) }]}
            />
          )}
          {/* Passive warning only: compaction is lossy, irreversible and billable,
              so it stays a decision the user makes. */}
          {nearLimit && <IconAlertTriangle size={12} color="var(--mantine-color-orange-6)" />}
        </UnstyledButton>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <ScrollArea.Autosize mah={480} type="auto">
          {content}
        </ScrollArea.Autosize>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
