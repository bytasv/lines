import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Box,
  Button,
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
  IconFile,
  IconRefresh,
  IconRobot,
  IconUser,
  IconRoute,
  IconZoomIn,
} from '@tabler/icons-react';
import type { TranscriptEvent, WorkflowMarkerData } from '@claude-ui/shared';
import { useStore } from '../store';
import { send } from '../ws';
import { buildTranscript, type TranscriptItem } from '../lib/transcript';
import { Markdown } from './Markdown';
import { ToolCallCard } from './ToolCallCard';
import { PermissionPrompt } from './PermissionPrompt';

function WorkflowMarker({ data }: { data: WorkflowMarkerData }) {
  const label =
    data.event === 'started'
      ? `Step ${data.stepIndex + 1}: ${data.stepName}`
      : data.event === 'retried'
        ? `Step ${data.stepIndex + 1}: ${data.stepName} — retry`
        : data.event === 'waiting-approval'
          ? `${data.stepName} — waiting for your approval`
          : data.event === 'approved'
            ? `${data.stepName} — approved`
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
      color={data.event === 'workflow-done' ? 'teal' : 'grape'}
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
  showRetry,
}: {
  item: TranscriptItem;
  sessionId: string;
  onImage: (src: string) => void;
  /** Render a Retry button (last transcript item is a failed result, session settled). */
  showRetry?: boolean;
}) {
  switch (item.kind) {
    case 'user':
      return (
        <Group align="flex-start" gap="xs" wrap="nowrap">
          <IconUser size={16} style={{ marginTop: 4, opacity: 0.5, flexShrink: 0 }} />
          <Paper radius="md" px="sm" py={6} bg="var(--mantine-color-default-hover)" style={{ flex: 1 }}>
            {item.source === 'workflow' && (
              <Badge variant="light" color="grape" mb={4}>
                workflow step prompt
              </Badge>
            )}
            {item.text && (
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {item.text}
              </Text>
            )}
            {item.attachments && item.attachments.length > 0 && (
              <Group gap="xs" mt={item.text ? 6 : 0}>
                {item.attachments.map((att) => {
                  const href = `${attachmentBase}${att.url}`;
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
        </Group>
      );
    case 'assistant':
      return (
        <Group align="flex-start" gap="xs" wrap="nowrap">
          <IconRobot size={16} style={{ marginTop: 4, opacity: 0.5, flexShrink: 0 }} />
          <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
            {item.blocks.map((block, i) => {
              if (block.type === 'text') return <Markdown key={i} text={block.text} />;
              if (block.type === 'thinking')
                return (
                  <Text key={i} size="xs" c="dimmed" fs="italic" style={{ whiteSpace: 'pre-wrap' }}>
                    {block.text.length > 600 ? block.text.slice(0, 600) + '…' : block.text}
                  </Text>
                );
              return <ToolCallCard key={block.id} tool={block} />;
            })}
          </Stack>
        </Group>
      );
    case 'streaming':
      return (
        <Group align="flex-start" gap="xs" wrap="nowrap">
          <Loader size={14} style={{ marginTop: 5, flexShrink: 0 }} />
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Markdown text={item.text} />
          </Box>
        </Group>
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
      // Guard-approved calls get a compact one-liner, not a full card.
      if (item.data.auto) {
        const summary =
          typeof item.data.input.command === 'string'
            ? item.data.input.command
            : String(item.data.input.file_path ?? item.data.input.url ?? '');
        return (
          <Text size="xs" c="dimmed" ta="center" ff="monospace" truncate>
            ⚡ auto-allowed {item.data.toolName}
            {summary ? ` · ${summary.slice(0, 80)}` : ''}
          </Text>
        );
      }
      return <PermissionPrompt sessionId={sessionId} data={item.data} resolution={item.resolution} />;
    case 'workflow':
      return <WorkflowMarker data={item.data} />;
  }
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
  const items = useMemo(() => buildTranscript(events), [events]);
  const status = useStore((s) => s.sessions[sessionId]?.status);
  // Retry only on the trailing failed result of a settled session — a retry
  // button mid-history or during a running turn would be stale/confusing.
  const lastItem = items.at(-1);
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
    pinnedRef.current = nearBottom;
    if (nearBottom) setHasNewContent(false);
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
            style={{ height: '100%', width: 0, background: 'var(--mantine-color-grape-5)' }}
          />
        </Box>
      )}
      <ScrollArea h="100%" viewportRef={viewportRef} px="md" onScrollPositionChange={onScroll}>
        <Stack gap="sm" py="md" maw={920} mx="auto">
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
              showRetry={item.key === retryKey}
            />
          ))}
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
