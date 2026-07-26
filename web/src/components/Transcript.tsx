import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Collapse,
  Divider,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useHover } from '@mantine/hooks';
import {
  IconArrowDown,
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconRefresh,
  IconRoute,
  IconZoomIn,
} from '@tabler/icons-react';
import type { TranscriptEvent, WorkflowMarkerData } from '@lines/shared';
import { useStore } from '../store';
import { send, withAuthToken } from '../ws';
import {
  buildTranscript,
  foldAgentTurns,
  turnToolStats,
  type AgentTurnItem,
  type TranscriptItem,
} from '../lib/transcript';
import { mentionKindMeta } from '../lib/mentions';
import { Markdown } from './Markdown';
import { ToolGroup } from './ToolGroup';
import { PermissionPrompt } from './PermissionPrompt';
import { ActivityRow } from './ActivityRow';

function WorkflowMarker({ data }: { data: WorkflowMarkerData }) {
  const label =
    data.event === 'started'
      ? `Step ${data.stepIndex + 1}: ${data.stepName}`
      : data.event === 'retried'
        ? `Step ${data.stepIndex + 1}: ${data.stepName} — retry`
        : data.event === 'waiting-approval'
          ? data.missingOutputs?.length
            ? `${data.stepName} — not run: nothing published for ${data.missingOutputs
                .map((n) => `{outputs.${n}}`)
                .join(', ')}`
            : `${data.stepName} — waiting for your approval`
          : data.event === 'approved'
            ? `${data.stepName} — approved`
            : data.event === 'interrupted'
              ? `${data.stepName} — stopped, moving to next step`
              : 'Workflow complete';
  return (
    <Divider
      // Anchor for the stepper's click-to-scroll; first 'started' marker is the step's start.
      {...(data.event === 'started' ? { 'data-workflow-step': data.stepIndex } : {})}
      label={
        <Group gap={6}>
          <IconRoute size={12} />
          <Text size="xs">{label}</Text>
        </Group>
      }
      labelPosition="center"
      color={data.event === 'workflow-done' ? 'teal' : 'slate'}
    />
  );
}

/** Attachments are served by the bridge HTTP server (same host, port 8787). */
const attachmentBase = `${location.protocol}//${location.hostname}:8787`;

/** Square image thumbnail with a zoom-icon overlay on hover; click opens the lightbox. */
function ImageThumb({ src, alt, onOpen }: { src: string; alt: string; onOpen: () => void }) {
  const { hovered, ref } = useHover<HTMLDivElement>();
  return (
    <Paper
      ref={ref}
      withBorder
      radius="md"
      title={alt}
      onClick={onOpen}
      style={{ position: 'relative', width: 72, height: 72, overflow: 'hidden', flexShrink: 0, cursor: 'zoom-in' }}
    >
      <img src={src} alt={alt} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      {hovered && (
        <Box
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.45)',
          }}
        >
          <IconZoomIn size={22} color="white" />
        </Box>
      )}
    </Paper>
  );
}

function Item({
  item,
  sessionId,
  onImage,
  retryKey,
  activeGroupKey,
  activeTurnKey,
}: {
  item: TranscriptItem;
  sessionId: string;
  onImage: (src: string) => void;
  /** Key of the trailing failed result that should show a Retry button, if any. */
  retryKey?: string | null;
  /** Key of the tool-group that is the agent's current (live) work — rendered expanded. */
  activeGroupKey?: string | null;
  /** Key of the agent-turn that is the current (live) turn — rendered expanded (Compact). */
  activeTurnKey?: string | null;
}) {
  const showRetry = item.key === retryKey;
  const isActiveGroup = item.key === activeGroupKey;
  switch (item.kind) {
    case 'user':
      // The only bubble in the transcript: a bubble means "a human said this".
      return (
        <Box style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Paper
            radius="md"
            px="sm"
            py={6}
            bg="var(--mantine-color-default-hover)"
            // minWidth: 0 is load-bearing twice — it stops a wide code block from
            // growing the flex item, and since used width is
            // max(min-width, min(max-width, width)), a default min-width: auto
            // (min-content) would beat maxWidth: 80% for one long unbreakable token.
            style={{ maxWidth: '80%', minWidth: 0, overflowWrap: 'anywhere' }}
          >
            {item.text && <Markdown text={item.text} />}
            {item.mentions && item.mentions.length > 0 && (
              <Group gap={6} mt={item.text ? 6 : 0}>
                {item.mentions.map((m) => {
                  const meta = mentionKindMeta[m.kind];
                  const Icon = meta?.icon;
                  return (
                    <Badge
                      key={`${m.kind}:${m.id}`}
                      variant="light"
                      color={meta?.color ?? 'gray'}
                      leftSection={Icon ? <Icon size={11} /> : undefined}
                      style={{ textTransform: 'none' }}
                    >
                      {m.label}
                    </Badge>
                  );
                })}
              </Group>
            )}
            {item.attachments && item.attachments.length > 0 && (
              <Group gap="xs" mt={item.text ? 6 : 0}>
                {item.attachments.map((att) => {
                  const href = withAuthToken(`${attachmentBase}${att.url}`);
                  // Render anything the browser shows as an image (incl. SVG, which
                  // the model receives as text but is still a displayable image).
                  if (att.mediaType.startsWith('image/')) {
                    return <ImageThumb key={att.url} src={href} alt={att.name} onOpen={() => onImage(href)} />;
                  }
                  return (
                    <Tooltip key={att.url} label={att.name}>
                      <Paper
                        withBorder
                        radius="md"
                        component="a"
                        href={href}
                        target="_blank"
                        style={{ width: 72, height: 72, overflow: 'hidden', flexShrink: 0, display: 'block', cursor: 'pointer' }}
                      >
                        <Stack align="center" justify="center" gap={2} h="100%" px={4}>
                          <IconFile size={22} opacity={0.6} />
                          <Text size="9px" ta="center" lineClamp={1} style={{ maxWidth: '100%' }}>
                            {att.name}
                          </Text>
                        </Stack>
                      </Paper>
                    </Tooltip>
                  );
                })}
              </Group>
            )}
          </Paper>
        </Box>
      );
    case 'assistant':
      // Agent output is unwrapped and flush-left — no bubble, no icon gutter.
      return (
        <Stack gap={6} style={{ minWidth: 0 }}>
          {item.blocks.map((block, i) => {
            if (block.type === 'text') return <Markdown key={i} text={block.text} />;
            return (
              <Text key={i} size="xs" c="dimmed" fs="italic" style={{ whiteSpace: 'pre-wrap' }}>
                {block.text.length > 600 ? block.text.slice(0, 600) + '…' : block.text}
              </Text>
            );
          })}
        </Stack>
      );
    case 'tool-group':
      return <ToolGroup group={item} active={!!isActiveGroup} sessionId={sessionId} />;
    case 'agent-turn':
      return (
        <AgentTurn
          turn={item}
          active={item.key === activeTurnKey}
          sessionId={sessionId}
          onImage={onImage}
          retryKey={retryKey}
          activeGroupKey={activeGroupKey}
        />
      );
    case 'streaming':
      // Liveness is the CSS caret, not a gutter Loader — an indent here would make
      // the text jump left the moment it settles into an 'assistant' item.
      return (
        <Box className="tx-streaming" style={{ minWidth: 0 }}>
          <Markdown text={item.text} />
        </Box>
      );
    case 'system-init':
      return (
        <Text size="xs" c="dimmed" ta="center">
          session started · {item.model}
        </Text>
      );
    case 'result':
      return (
        <Group gap="xs" justify="center">
          <Text size="xs" c={item.isError ? 'red' : 'dimmed'} ta="center">
            {item.isError ? 'turn failed' : 'turn done'}
            {item.costUsd != null ? ` · $${item.costUsd.toFixed(4)}` : ''}
            {item.durationMs != null ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ''}
          </Text>
          {showRetry && (
            <Button
              size="compact-xs"
              variant="light"
              color="red"
              leftSection={<IconRefresh size={12} />}
              onClick={() => send({ type: 'retryTurn', sessionId })}
            >
              Retry
            </Button>
          )}
        </Group>
      );
    case 'permission':
      // Auto-allowed calls are filtered out upstream; only real prompts reach here.
      return <PermissionPrompt sessionId={sessionId} data={item.data} resolution={item.resolution} />;
    case 'workflow':
      return <WorkflowMarker data={item.data} />;
  }
}

// Sticky per-turn override (Compact level), keyed `${sessionId}:${turn.key}`. Module scope
// so it survives Transcript remount and rebuilds; `t*` keys never collide with `g*` groups.
const turnOverrides = new Map<string, boolean>();

function AgentTurn({
  turn,
  active,
  sessionId,
  onImage,
  retryKey,
  activeGroupKey,
}: {
  turn: AgentTurnItem;
  active: boolean;
  sessionId: string;
  onImage: (src: string) => void;
  retryKey?: string | null;
  activeGroupKey?: string | null;
}) {
  const k = `${sessionId}:${turn.key}`;
  const [override, setOverride] = useState<boolean | null>(() => turnOverrides.get(k) ?? null);
  const expanded = override ?? active;
  const toggle = () => {
    turnOverrides.set(k, !expanded);
    setOverride(!expanded);
  };

  const turnSummariesEnabled = useStore((s) => s.turnSummariesEnabled);
  const { narrative, narration, summary, totals, result } = turnToolStats(turn.items);
  // AI narrative (if enabled) > the agent's own narration > tool tally > generic fallback.
  const headline = (turnSummariesEnabled ? narrative : null) ?? narration ?? summary ?? 'response';
  const isHeadlineSentence = headline !== summary || headline === 'response';

  return (
    <Box>
      <Group
        className="tx-row"
        gap="xs"
        wrap="nowrap"
        justify="space-between"
        onClick={toggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
          {expanded ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
            <Text size="xs" fw={isHeadlineSentence ? 400 : 600} lineClamp={2}>
              {headline}
            </Text>
            {summary && headline !== summary && (
              <Text size="xs" c="dimmed" truncate>
                {summary}
              </Text>
            )}
          </Stack>
        </Group>
        <Group gap={6} wrap="nowrap">
          {totals && (
            <Text size="xs" ff="monospace">
              <Text span c="teal">
                +{totals.added}
              </Text>{' '}
              <Text span c="red">
                −{totals.removed}
              </Text>
            </Text>
          )}
          {result?.durationMs != null && (
            <Text size="xs" c="dimmed">
              {(result.durationMs / 1000).toFixed(1)}s
            </Text>
          )}
          {active && <Loader size={12} />}
        </Group>
      </Group>
      <Collapse expanded={expanded} transitionDuration={150}>
        <Stack gap={6} mt={4}>
          {turn.items.map((child) => (
            <Item
              key={child.key}
              item={child}
              sessionId={sessionId}
              onImage={onImage}
              retryKey={retryKey}
              activeGroupKey={activeGroupKey}
            />
          ))}
        </Stack>
      </Collapse>
    </Box>
  );
}

export function Transcript({
  sessionId,
  events,
  stepCount,
}: {
  sessionId: string;
  events: TranscriptEvent[];
  /** Workflow step count — segments the scroll progress bar per step. */
  stepCount?: number;
}) {
  const compactionLevel = useStore((s) => s.compactionLevel);
  // Flat item list. Full level ('full') leaves tools ungrouped (1-tool groups render bare);
  // otherwise consecutive tools fold into tool-groups. Auto-allowed permission one-liners
  // are redundant (their tool shows in the group card) so drop them; real prompts stay.
  const { built, live } = useMemo(() => {
    const { items, live } = buildTranscript(events, compactionLevel !== 'full');
    return { built: items.filter((it) => !(it.kind === 'permission' && it.data.auto)), live };
  }, [events, compactionLevel]);
  // Compact level additionally folds each agent turn into a collapsible super-group.
  const items = useMemo(
    () => (compactionLevel === 'compact' ? foldAgentTurns(built) : built),
    [built, compactionLevel],
  );
  const status = useStore((s) => s.sessions[sessionId]?.status);
  const turnStartedAt = useStore((s) => s.sessions[sessionId]?.turnStartedAt);
  const lastEventAt = useStore((s) => s.lastEventAt[sessionId]);
  // The active group is the latest tool-group while the session is live — it renders
  // expanded; any earlier group auto-collapses. Computed on the flat list so the key is
  // found even when the group is nested inside a folded turn. Pending permissions belong to it.
  const activeGroupKey = useMemo(() => {
    if (status !== 'running' && status !== 'waiting-permission') return null;
    for (let i = built.length - 1; i >= 0; i--) {
      const it = built[i];
      if (it.kind === 'permission') continue;
      return it.kind === 'tool-group' ? it.key : null;
    }
    return null;
  }, [built, status]);
  // The active turn (Compact level) is the latest agent-turn while the session is live.
  const activeTurnKey = useMemo(() => {
    if (status !== 'running' && status !== 'waiting-permission') return null;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === 'agent-turn') return items[i].key;
    }
    return null;
  }, [items, status]);
  // Standalone activity row: shown while running unless the transcript tail
  // already carries a live indicator (streaming text, active group/turn loader,
  // or an open permission card). A live thinking/tool-prep phase overrides the
  // group/turn loaders — a stale previous-call spinner must not mask
  // "Writing plan…" — but never the streaming-text tail.
  const showActivity = useMemo(() => {
    if (status !== 'running') return false;
    const last = items.at(-1);
    if (!last) return true;
    if (last.kind === 'streaming') return false;
    if (last.kind === 'permission' && !last.resolution) return false;
    const phaseOverride = live?.phase === 'thinking' || live?.phase === 'tool-prep';
    if (!phaseOverride && (last.key === activeGroupKey || last.key === activeTurnKey)) return false;
    return true;
  }, [items, status, live, activeGroupKey, activeTurnKey]);
  // Fallback for sessions that predate turnStartedAt: the last user prompt's ts.
  const activityStartedAt = useMemo(() => {
    if (turnStartedAt != null) return turnStartedAt;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].kind === 'user') return events[i].ts;
    }
    return undefined;
  }, [turnStartedAt, events]);
  // Retry only on the trailing failed result of a settled session — a retry
  // button mid-history or during a running turn would be stale/confusing.
  // Use the flat list so it's found even when the result is folded into a turn.
  const lastItem = built.at(-1);
  const retryKey =
    lastItem?.kind === 'result' &&
    lastItem.isError &&
    status !== 'running' &&
    status !== 'waiting-permission'
      ? lastItem.key
      : null;
  const [lightbox, setLightbox] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  // Pinned = follow the stream. Scrolling up unpins; scrolling back down repins.
  const pinnedRef = useRef(true);
  const [hasNewContent, setHasNewContent] = useState(false);
  // Progress bar is updated imperatively — state here would re-render the whole
  // transcript on every scroll frame.
  const progressTrackRef = useRef<HTMLDivElement>(null);
  // Content element — observed for size changes so we re-pin on height shifts
  // that add no items (e.g. a turn's Collapse expanding on a status change).
  const contentRef = useRef<HTMLDivElement>(null);
  // While > now, onScroll ignores unpin — set right after a reflow-driven scroll
  // so a collapse/expand doesn't get mistaken for a user scrolling up.
  const suppressUnpinUntilRef = useRef(0);

  const updateProgress = () => {
    const el = viewportRef.current;
    if (!el) return;
    const maxScroll = el.scrollHeight - el.clientHeight;
    // Own single-segment track (non-workflow sessions): hide when content fits.
    const ownTrack = progressTrackRef.current;
    if (ownTrack) ownTrack.style.display = maxScroll > 4 ? 'block' : 'none';

    // Fills live either in the WorkflowStepper connectors or in our own track.
    const fills = document.querySelectorAll<HTMLElement>('[data-progress-fill]');
    const n = fills.length;
    if (n === 0) return;
    if (maxScroll <= 4) {
      fills.forEach((fill) => (fill.style.width = '0%'));
      return;
    }
    const pos = Math.min(el.scrollTop, maxScroll);

    // Segment boundaries in scroll coordinates: step i spans [bounds[i], bounds[i+1]].
    // Steps without a start marker yet haven't run — their segments stay empty.
    const started = new Array<boolean>(n).fill(false);
    started[0] = true; // pre-marker content belongs to step 1
    const bounds = new Array<number>(n + 1).fill(maxScroll);
    bounds[0] = 0;
    if (n > 1) {
      const viewportTop = el.getBoundingClientRect().top;
      el.querySelectorAll<HTMLElement>('[data-workflow-step]').forEach((marker) => {
        const i = Number(marker.dataset.workflowStep);
        if (i >= 0 && i < n) {
          started[i] = true;
          if (i > 0) {
            bounds[i] = Math.min(
              maxScroll,
              marker.getBoundingClientRect().top - viewportTop + el.scrollTop,
            );
          }
        }
      });
      // Keep boundaries monotonic in case markers render out of order.
      for (let i = 1; i <= n; i++) bounds[i] = Math.max(bounds[i], bounds[i - 1]);
    }

    fills.forEach((fill, i) => {
      if (!started[i]) {
        fill.style.width = '0%';
        return;
      }
      const span = bounds[i + 1] - bounds[i];
      const frac =
        pos >= bounds[i + 1] ? 1 : pos <= bounds[i] || span <= 0 ? 0 : (pos - bounds[i]) / span;
      fill.style.width = `${frac * 100}%`;
    });
  };

  const scrollToBottom = (smooth = false) => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    pinnedRef.current = true;
    setHasNewContent(false);
  };

  const onScroll = () => {
    const el = viewportRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom) {
      pinnedRef.current = true;
      setHasNewContent(false);
    } else if (Date.now() >= suppressUnpinUntilRef.current) {
      // A reflow (a turn collapsing/expanding on a step change) can move the
      // bottom away and fire a scroll event that mimics a user scroll-up. Only
      // honor the unpin outside the brief window after such a reflow.
      pinnedRef.current = false;
    }
    updateProgress();
  };

  useEffect(() => {
    if (pinnedRef.current) {
      scrollToBottom();
    } else if (items.length > 0) {
      setHasNewContent(true);
    }
    updateProgress();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // Layout can change height without changing items — a turn's Collapse
  // animating open on a status change, the approval panel unmounting, or late
  // content streaming in. Re-pin on any such resize so we stay at the bottom.
  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) {
        // Keep following through the resize burst (collapse/expand animation)
        // and hold off the scroll-driven unpin it would otherwise trigger.
        suppressUnpinUntilRef.current = Date.now() + 200;
        scrollToBottom();
      }
      updateProgress();
    });
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box style={{ flex: 1, position: 'relative', minHeight: 0 }}>
      {stepCount == null && (
        <Box
          ref={progressTrackRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            zIndex: 2,
            display: 'none',
            background: 'var(--mantine-color-default-hover)',
          }}
        >
          <Box
            data-progress-fill
            style={{ height: '100%', width: 0, background: 'var(--mantine-color-sandstone-6)' }}
          />
        </Box>
      )}
      <ScrollArea h="100%" viewportRef={viewportRef} px="md" onScrollPositionChange={onScroll}>
        <Stack gap="sm" py="md" maw={920} mx="auto" ref={contentRef}>
          {items.length === 0 && (
            <Text size="sm" c="dimmed" ta="center" pt="xl">
              Send a prompt to start.
            </Text>
          )}
          {items.map((item) => (
            <Item
              key={item.key}
              item={item}
              sessionId={sessionId}
              onImage={setLightbox}
              retryKey={retryKey}
              activeGroupKey={activeGroupKey}
              activeTurnKey={activeTurnKey}
            />
          ))}
          {showActivity && (
            <ActivityRow startedAt={activityStartedAt} live={live} lastEventAt={lastEventAt} />
          )}
        </Stack>
      </ScrollArea>
      {hasNewContent && (
        <Button
          radius="xl"
          size="compact-xs"
          variant="filled"
          fz={10.5}
          leftSection={<IconArrowDown size={11} />}
          onClick={() => scrollToBottom(true)}
          style={{
            position: 'absolute',
            bottom: 10,
            left: '50%',
            transform: 'translateX(-50%)',
            boxShadow: 'var(--mantine-shadow-md)',
          }}
        >
          new content
        </Button>
      )}
      <Modal
        opened={lightbox !== null}
        onClose={() => setLightbox(null)}
        withCloseButton={false}
        centered
        padding={0}
        size="auto"
        styles={{ content: { background: 'transparent', boxShadow: 'none' } }}
      >
        {lightbox && (
          <img
            src={lightbox}
            alt=""
            style={{ maxWidth: '90vw', maxHeight: '90vh', display: 'block', borderRadius: 8 }}
          />
        )}
      </Modal>
    </Box>
  );
}
