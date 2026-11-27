import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Collapse,
  Divider,
  Group,
  Loader,
  Popover,
  Progress,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  type MantineTransition,
} from '@mantine/core';
import { useHover } from '@mantine/hooks';
import { IconAlertTriangle, IconChevronRight, IconPlugConnected } from '@tabler/icons-react';
import type {
  ContextBreakdown,
  ContextCategory,
  ContextSummary,
  ContextUsage,
  McpServerStatusInfo,
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
import { useIsGuestOnSession, useSessionMachineHealth } from '../lib/can';
import { humanizeToolName, mcpProvider } from '../lib/mcpTools';
import { mcpCallCount, summarizeMcpUsage, type McpAccess, type McpUsage } from '../lib/mcpUsage';
import { McpLogo } from './McpToolLabel';
import { useReveal } from '../lib/layout';
import { send } from '../ws';
import { formatDuration, formatSpendUsd, formatTokens, withLiveSpend } from '../lib/format';
import styles from './Composer.module.css';

/** The popover rises 8px into place, slightly scaled, on a spring-like curve. */
const POPOVER_TRANSITION: MantineTransition = {
  in: { opacity: 1, transform: 'translateY(0) scale(1)' },
  out: { opacity: 0, transform: 'translateY(8px) scale(0.96)' },
  transitionProperty: 'opacity, transform',
};

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
  compact = false,
}: {
  category: ContextCategory;
  /** null for deferred rows — they aren't in the window, so a share of it would lie. */
  percent: number | null;
  detail: React.ReactNode | null;
  expanded: boolean;
  onToggle: () => void;
  /** The composer popover's row: name and tokens only, in its own type. */
  compact?: boolean;
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
        {compact ? (
          <Text span truncate className={styles.cpKey} opacity={category.deferred ? 0.7 : undefined}>
            {category.name}
          </Text>
        ) : (
          <Text size="xs" truncate c={category.deferred ? 'dimmed' : undefined}>
            {category.name}
          </Text>
        )}
      </Group>
      {compact ? (
        <span className={styles.cpValue}>{formatTokens(category.tokens)}</span>
      ) : (
        <>
          <Text size="xs" fw={600}>
            {formatTokens(category.tokens)}
          </Text>
          <Text size="xs" c="dimmed" w={PERCENT_W} ta="right">
            {percent == null ? '—' : `${percent.toFixed(1)}%`}
          </Text>
        </>
      )}
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

/** The CLI's own form of a server name in tool names: anything outside `[A-Za-z0-9_-]` becomes `_`. */
function toolServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

const STATUS_COLOR: Record<McpServerStatusInfo['status'], string> = {
  connected: 'var(--mantine-color-green-6)',
  pending: 'var(--mantine-color-yellow-6)',
  'needs-auth': 'var(--mantine-color-orange-6)',
  failed: 'var(--mantine-color-red-6)',
  disabled: 'var(--mantine-color-gray-5)',
};

const STATUS_LABEL: Record<McpServerStatusInfo['status'], string> = {
  connected: 'Connected',
  pending: 'Connecting',
  'needs-auth': 'Needs sign-in',
  failed: 'Failed to connect',
  disabled: 'Disabled',
};

const ACCESS_CHIPS: { key: keyof McpAccess; label: string; color: string }[] = [
  { key: 'user', label: 'You allowed', color: 'var(--mantine-color-green-text)' },
  { key: 'auto', label: 'Allowlist', color: 'var(--mantine-color-blue-text)' },
  { key: 'denied', label: 'You denied', color: 'var(--mantine-color-red-text)' },
  { key: 'unprompted', label: 'No prompt', color: 'var(--composer-faint)' },
];

function AccessChips({ access, calls }: { access: McpAccess; calls: number }) {
  return (
    <span className={styles.cpChips}>
      {ACCESS_CHIPS.filter((c) => access[c.key] > 0).map((c) => (
        <span key={c.key} className={styles.cpChip} style={{ color: c.color }}>
          {c.label}
          {calls > 1 ? ` ${access[c.key]}` : ''}
        </span>
      ))}
    </span>
  );
}

/**
 * The popover's right column: one card per MCP provider the session called,
 * expandable to its tools, how often each ran and how its access was granted;
 * an empty state until the first call. Connected servers nothing called are not
 * listed: Settings → Connections owns that view. Everything but the status dot
 * comes from the transcript (see summarizeMcpUsage). `statuses` is the owner's
 * alone — a guest passes none, so sees no status dot.
 */
function McpConnectionsUsed({
  usage,
  breakdown,
  statuses,
  open,
  toggle,
}: {
  usage: McpUsage[];
  breakdown: ContextBreakdown | null;
  statuses: McpServerStatusInfo[] | undefined;
  open: Set<string>;
  toggle: (key: string) => void;
}) {
  const statusOf = (server: string) => statuses?.find((s) => toolServerName(s.name) === server);
  const tokensOf = (server: string) =>
    breakdown?.mcpServers.find((s) => toolServerName(s.serverName) === server)?.tokens;
  return (
    <div className={styles.contextPopover}>
      {/* No heading over the empty state: the placeholder says it all. */}
      {usage.length > 0 && <span className={styles.cpHeading}>Connections used</span>}
      {usage.length === 0 ? (
        <div className={styles.cpEmpty}>
          <span className={styles.cpEmptyIcon}>
            <IconPlugConnected size={20} stroke={1.5} />
          </span>
          <span className={styles.cpEmptyTitle}>No connections used yet</span>
          <span className={styles.cpNote}>
            When the agent calls an MCP tool, the provider shows up here with its calls, context cost and how
            access was granted.
          </span>
        </div>
      ) : (
        <div className={styles.cpRows}>
          {usage.map((u) => {
            const key = `mcp:${u.server}`;
            const expanded = open.has(key);
            const status = statusOf(u.server);
            const tokens = tokensOf(u.server);
            return (
              <div key={u.server} className={styles.cpCard}>
                <UnstyledButton
                  className={styles.cpCardHead}
                  onClick={() => toggle(key)}
                  aria-expanded={expanded}
                >
                  <IconChevronRight
                    size={12}
                    style={{
                      flexShrink: 0,
                      transform: expanded ? 'rotate(90deg)' : undefined,
                      transition: 'transform 150ms',
                    }}
                  />
                  <McpLogo server={u.server} size={20} />
                  <span className={styles.cpCardTitle} title={u.server}>
                    {mcpProvider(u.server).label}
                  </span>
                  {status && (
                    <Tooltip label={status.error ?? STATUS_LABEL[status.status]} withArrow multiline maw={240}>
                      <span className={styles.cpStatusDot} style={{ background: STATUS_COLOR[status.status] }} />
                    </Tooltip>
                  )}
                  <span className={styles.cpCardMeta}>
                    {u.calls} call{u.calls === 1 ? '' : 's'}
                    {u.errors > 0 && <span style={{ color: 'var(--mantine-color-red-text)' }}> · {u.errors} failed</span>}
                    {tokens != null && ` · ${formatTokens(tokens)}`}
                  </span>
                </UnstyledButton>
                <Collapse expanded={expanded} transitionDuration={150}>
                  <div className={styles.cpCardBody}>
                    {u.tools.map((t) => (
                      <div key={t.tool} className={styles.cpToolRow}>
                        <span className={styles.cpKey} title={`mcp__${u.server}__${t.tool}`}>
                          {humanizeToolName(t.tool)}
                        </span>
                        <span className={styles.cpValue}>
                          ×{t.calls}
                          {t.errors > 0 && (
                            <span style={{ color: 'var(--mantine-color-red-text)' }}> · {t.errors} failed</span>
                          )}
                        </span>
                        <AccessChips access={t.access} calls={t.calls} />
                      </div>
                    ))}
                    <span className={styles.cpNote}>
                      How access was granted, matched by tool name — not a per-call record.
                    </span>
                  </div>
                </Collapse>
              </div>
            );
          })}
        </div>
      )}
    </div>
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
  const requestMcpStatus = useStore((s) => s.requestMcpStatus);
  // MCP server status names the host's configured servers: the owner's alone,
  // the same gate as the Connections pane (the server answers owners only).
  const isGuest = useIsGuestOnSession(session.id);
  const mcpStatuses = useStore((s) => (isGuest ? undefined : s.mcpStatus[session.id]));
  // Derived from settled transcript events (the store flushes before anyone
  // reads them) and memoized on the array, which only changes on a flush.
  const events = useStore((s) => s.transcripts[session.id]);
  const mcpUsage = useMemo(() => (events ? summarizeMcpUsage(events) : []), [events]);
  // Settled total plus the in-flight turn's live estimate, while one runs.
  const liveSpend = useStore((s) => s.turnSpend[session.id]);
  const cost = withLiveSpend(session.totalCostUsd, liveSpend, hasEstimatedSpend(session.costByModel));
  const health = useSessionMachineHealth(session.id);
  const hasReading = Boolean(session.contextSummary || session.contextUsage);
  useEffect(() => {
    if (
      inline && hasReading && health.connected && health.bridgeAttached &&
      sessionCaps(session).contextWindow
    ) {
      requestContextBreakdown(session.id);
      if (!isGuest) requestMcpStatus(session.id);
    }
  }, [
    inline, hasReading, health.connected, health.bridgeAttached,
    session.id, session.model, requestContextBreakdown, isGuest, requestMcpStatus,
  ]);
  // Expansion state must live here, not in the dropdown: the Popover unmounts its
  // dropdown on close, which would reset it every time the pointer leaves.
  const [open, setOpen] = useState<Set<string>>(new Set());
  /** The composer's popover, opened by a click on the ring. */
  const [opened, setOpened] = useState(false);
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
      {cost.usd != null && <TotalRow label="Cost" value={formatSpendUsd(cost.usd, cost.estimated)} />}
      {session.totalDurationMs != null && (
        <TotalRow label="Active time" value={formatDuration(session.totalDurationMs)} />
      )}
    </Stack>
  );
  const mcpCalls = mcpCallCount(mcpUsage);
  const connected = (mcpStatuses ?? []).some((s) => s.status !== 'disabled');
  const showMcp = mcpCalls > 0 || connected;
  const connections = showMcp ? (
    <McpConnectionsUsed
      usage={mcpUsage}
      breakdown={entry?.breakdown ?? null}
      statuses={mcpStatuses}
      open={open}
      toggle={toggle}
    />
  ) : null;

  if (inline) {
    return connections ? (
      <Stack gap="xs">
        {content}
        <Divider />
        {connections}
      </Stack>
    ) : (
      content
    );
  }

  // The composer's popover: what fills the window, the session's totals, and
  // compaction — the categories keep their per-item detail behind a click.
  const rows = view
    ? view.categories.filter((c) => categoryKey(c.name) !== 'free space' && c.tokens > 0)
    : [];
  const promptTokens = usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens : 0;
  const cacheHits = usage && promptTokens > 0 ? (usage.cacheReadTokens / promptTokens) * 100 : null;
  const autoCompactNote =
    view?.isAutoCompactEnabled === false
      ? 'Auto-compact is off'
      : view?.isAutoCompactEnabled && view.autoCompactThreshold != null
        ? view.maxTokens > 0
          ? `Auto-compacts at ${Math.round((view.autoCompactThreshold / view.maxTokens) * 100)}%`
          : `Auto-compacts at ${formatTokens(view.autoCompactThreshold)}`
        : '';
  const compactBlock = contextCompactBlock(session);
  const stat = (label: string, value: string) => (
    <div className={styles.cpStat}>
      <span className={styles.cpStatLabel}>{label}</span>
      <span className={styles.cpStatValue}>{value}</span>
    </div>
  );
  const popoverContent = (
    <div className={styles.contextPopover}>
      {view ? (
        <div className={styles.cpRows}>
          {rows.map((c) => (
            <CategoryRow
              key={c.name}
              compact
              category={c}
              percent={null}
              detail={
                entry?.breakdown ? categoryDetail(categoryKey(c.name), c.deferred === true, entry.breakdown) : null
              }
              expanded={open.has(c.name)}
              onToggle={() => toggle(c.name)}
            />
          ))}
        </div>
      ) : (
        usage && <FallbackBody usage={usage} />
      )}
      {entry?.loading && <Loader size={10} />}
      {compacted != null && (
        <span className={styles.cpNote}>
          {session.contextCompact?.trigger === 'auto'
            ? 'Auto-compacted since the last measured turn'
            : 'Compacted since the last measured turn'}
          {` — ${formatTokens(compacted)} in context.`}
        </span>
      )}
      {stale && (
        <span className={styles.cpNote}>
          The conversation was reset for a fresh step — this reading is from before that.
        </span>
      )}
      {nearLimit && (
        <Group gap={6} wrap="nowrap">
          <IconAlertTriangle size={12} color="var(--mantine-color-orange-6)" />
          <Text size="xs" c="orange">
            Over {CONTEXT_WARN_PCT}% of the window — compacting now frees room for the rest of the task.
          </Text>
        </Group>
      )}
      <div className={styles.cpDivider} />
      <div className={styles.cpStats}>
        {session.totalTokens != null && stat('Session tokens', formatTokens(session.totalTokens))}
        {cacheHits != null && stat('Cache hits', `${Math.round(cacheHits)}%`)}
        {cost.usd != null && stat('Cost', formatSpendUsd(cost.usd, cost.estimated))}
      </div>
      <div className={styles.cpFooter}>
        <span className={styles.cpNote}>{autoCompactNote}</span>
        {/* Disabled in several legitimately different situations, so it always
            states which one: the shared predicate's own `reason`. */}
        <Tooltip
          label={compactBlock?.reason ?? "Compact this session's context now"}
          multiline
          w={240}
          withArrow
          position="top"
        >
          <span style={{ display: 'flex' }}>
            <UnstyledButton
              className={styles.primaryButton}
              disabled={compactBlock !== null}
              onClick={() => {
                send({ type: 'compactContext', sessionId: session.id });
                setOpened(false);
              }}
            >
              Compact now
            </UnstyledButton>
          </span>
        </Tooltip>
      </div>
    </div>
  );

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      onOpen={() => {
        requestContextBreakdown(session.id);
        if (!isGuest) requestMcpStatus(session.id);
      }}
      width={showMcp ? 'min(680px, calc(100vw - 2rem))' : 'min(354px, calc(100vw - 2rem))'}
      position="top-end"
      offset={14}
      withArrow
      arrowSize={13}
      arrowOffset={30}
      transitionProps={{ transition: POPOVER_TRANSITION, duration: 260, timingFunction: 'cubic-bezier(0.22, 1.15, 0.36, 1)' }}
      classNames={{
        dropdown: `${styles.palette} ${styles.popover}`,
        arrow: styles.popoverArrow,
      }}
    >
      <Popover.Target>
        <UnstyledButton
          className={styles.context}
          aria-label={
            mcpCalls > 0
              ? `Context window usage, ${mcpCalls} MCP call${mcpCalls === 1 ? '' : 's'} to ${mcpUsage.length} provider${mcpUsage.length === 1 ? '' : 's'}`
              : 'Context window usage'
          }
          style={{ opacity: stale ? 0.45 : 1 }}
          onClick={() => setOpened((o) => !o)}
        >
          {pct == null ? (
            `${formatTokens(fallbackUsed)} ctx`
          ) : (
            <>
              {/* A stale reading drops its colour, so it can't read as a live measurement. */}
              <span
                className={styles.contextRing}
                style={
                  {
                    '--ring-pct': `${pct}%`,
                    '--ring-color': stale
                      ? 'var(--composer-faint)'
                      : nearLimit
                        ? 'var(--mantine-color-orange-6)'
                        : undefined,
                  } as React.CSSProperties
                }
              >
                <span className={styles.contextRingIn} />
              </span>
              {Math.round(pct)}%
            </>
          )}
          {/* Passive warning only: compaction is lossy, irreversible and billable,
              so it stays a decision the user makes. */}
          {nearLimit && <IconAlertTriangle size={12} color="var(--mantine-color-orange-6)" />}
          {mcpCalls > 0 && (
            <Box component="span" visibleFrom="sm" className={styles.contextMcp}>
              <span className={styles.contextLogos}>
                {mcpUsage.slice(0, 3).map((u, i) => (
                  <McpLogo
                    key={u.server}
                    server={u.server}
                    size={14}
                    ring="var(--composer-surface)"
                    style={{ marginLeft: i === 0 ? 0 : -4, zIndex: 3 - i, position: 'relative' }}
                  />
                ))}
                {mcpUsage.length > 3 && <span className={styles.contextMore}>+{mcpUsage.length - 3}</span>}
              </span>
              {mcpCalls} call{mcpCalls === 1 ? '' : 's'}
            </Box>
          )}
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown p={16}>
        <ScrollArea.Autosize mah={480} type="auto">
          {connections ? (
            <div className={styles.cpGrid}>
              {popoverContent}
              <div className={styles.cpSide}>{connections}</div>
            </div>
          ) : (
            popoverContent
          )}
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}
