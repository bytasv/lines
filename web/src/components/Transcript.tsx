import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ActionIcon,
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
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useClipboard, useHover } from '@mantine/hooks';
import {
  IconArchive,
  IconArrowBackUp,
  IconArrowDown,
  IconBolt,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconFile,
  IconLogin,
  IconPencil,
  IconPlayerSkipForward,
  IconRefresh,
  IconRoute,
  IconZoomIn,
} from '@tabler/icons-react';
import type {
  Attachment,
  ContextCompactData,
  PermissionRequestData,
  TranscriptEvent,
  WorkflowMarkerData,
} from '@lines/shared';
import { rewindBlock } from '@lines/shared';
import { useStore } from '../store';
import { send } from '../ws';
import {
  buildTranscript,
  foldAgentTurns,
  reconcileItems,
  turnToolStats,
  type AgentTurnItem,
  type TranscriptItem,
} from '../lib/transcript';
import { REVEAL_STEP_EVENT } from '../lib/workflowReveal';
import { useAttachmentUrl } from '../lib/files';
import { mentionKindMeta } from '../lib/mentions';
import { formatTokens, skippableFailedStep } from '../lib/format';
import { useClaudeLoginNeeded } from '../lib/can';
import { PromptAuthor } from './PromptAuthor';
import { Markdown } from './Markdown';
import { ToolGroup } from './ToolGroup';
import { PermissionPrompt } from './PermissionPrompt';
import { ActivityRow } from './ActivityRow';
import { ConfirmModal } from './ConfirmModal';

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
            : data.failed
              ? `${data.stepName} — failed, retry or approve to skip`
              : `${data.stepName} — waiting for your approval`
          : data.event === 'approved'
            ? `${data.stepName} — approved`
            : data.event === 'interrupted'
              ? `${data.stepName} — stopped and marked completed`
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

/** Compaction marker: the conversation up to here was replaced by a summary. */
function ContextCompactMarker({ data }: { data: ContextCompactData }) {
  const pending = data.phase === 'requested';
  const failed = data.ok === false;
  const label = pending
    ? 'Compacting context…'
    : failed
      ? data.error === 'no-compact-boundary'
        ? 'Compaction unavailable — nothing was compacted'
        : 'Compaction stopped — nothing was compacted'
      : data.preTokens != null && data.postTokens != null
        ? `Compacted: ${formatTokens(data.preTokens)} → ${formatTokens(data.postTokens)} tokens`
        : data.trigger === 'auto'
          ? 'Context auto-compacted'
          : 'Context compacted';
  return (
    <Divider
      label={
        <Group gap={6}>
          {pending ? <Loader size={10} /> : <IconArchive size={12} />}
          <Text size="xs">{label}</Text>
        </Group>
      }
      labelPosition="center"
      color={failed ? 'orange' : 'slate'}
    />
  );
}

/**
 * One attachment tile. A component rather than inline JSX because each tile
 * resolves its own blob URL through a hook, and hooks can't run inside a .map()
 * callback. Attachments arrive as base64 over the socket now — see
 * useAttachmentUrl.
 */
function AttachmentTile({
  att,
  onImage,
}: {
  att: Attachment;
  onImage: (src: string) => void;
}) {
  // att.url is the legacy `/attachments/<sessionId>/<file>` shape; the request
  // takes the part below the user's attachments root.
  const rel = decodeURIComponent(att.url.replace(/^\/attachments\//, ''));
  const { url } = useAttachmentUrl(rel);

  // Render anything the browser shows as an image (incl. SVG, which the model
  // receives as text but is still a displayable image).
  if (att.mediaType.startsWith('image/')) {
    if (!url) return <Skeleton width={72} height={72} radius="md" />;
    return <ImageThumb src={url} alt={att.name} onOpen={() => onImage(url)} />;
  }
  return (
    <Tooltip label={att.name}>
      <Paper
        withBorder
        radius="md"
        component="a"
        href={url ?? undefined}
        target="_blank"
        rel="noreferrer noopener"
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
}

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

/** Chars of a user prompt rendered before it collapses behind a toggle. */
const USER_TEXT_CAP = 4000;

/**
 * A user prompt, capped. Workflow hand-off prompts splice in the working-tree diff
 * and prior step output, and user items are fold *boundaries* — never collapsed,
 * always rendered on first paint. Running ReactMarkdown + highlight over a
 * multi-megabyte prompt blocks the main thread long enough to trip the socket
 * heartbeat, and the reconnect re-downloads the transcript into the same stall.
 */
function UserText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length <= USER_TEXT_CAP) return <Markdown text={text} />;
  return (
    <>
      <Markdown text={expanded ? text : text.slice(0, USER_TEXT_CAP) + '\n\n…'} />
      <Button variant="subtle" size="compact-xs" mt={4} onClick={() => setExpanded((e) => !e)}>
        {expanded
          ? 'Show less'
          : `Show full message (${Math.round(text.length / 1000).toLocaleString()}k chars)`}
      </Button>
    </>
  );
}

/**
 * What the user can do about the trailing failed turn. Reads the session straight
 * out of the store rather than threading two more props through Item/AgentTurn;
 * `retryKey` upstream is still the only gate on whether this renders at all.
 */
function FailedTurnActions({ sessionId }: { sessionId: string }) {
  const needsSignIn = useStore((s) => s.sessions[sessionId]?.errorKind === 'auth');
  const loggedOut = useClaudeLoginNeeded();
  const openLoginModal = useStore((s) => s.openLoginModal);
  const skipStep = useStore((s) => {
    const session = s.sessions[sessionId];
    return session ? skippableFailedStep(session) : null;
  });
  const connected = useStore((s) => s.connectionStatus === 'connected');
  return (
    <>
      {needsSignIn && loggedOut && (
        <Button size="compact-xs" color="red" leftSection={<IconLogin size={12} />} onClick={openLoginModal}>
          Sign in
        </Button>
      )}
      {skipStep !== null && (
        <Button
          size="compact-xs"
          variant="light"
          color="red"
          leftSection={<IconPlayerSkipForward size={12} />}
          // ws.ts silently drops non-prompt messages on a closed socket.
          disabled={!connected}
          onClick={() => send({ type: 'workflowApprove', sessionId, stepIndex: skipStep })}
        >
          Skip step
        </Button>
      )}
      <Button
        size="compact-xs"
        variant="light"
        color="red"
        leftSection={<IconRefresh size={12} />}
        onClick={() => send({ type: 'retryTurn', sessionId })}
      >
        Retry
      </Button>
    </>
  );
}

/** What a confirmed rewind does with the message it rewound to. */
type RewindIntent = 'edit' | 'rewind';

/**
 * A sent prompt, with its Copy / Edit / Rewind actions revealed under the bubble
 * on hover. Edit and Rewind both discard this message and everything after it;
 * Edit additionally hands the text back to the composer. Copy is a plain
 * clipboard read and is never gated.
 *
 * Its own component because the hover/confirm state needs hooks, which the
 * switch in {@link Item} cannot host.
 */
function UserBubble({
  item,
  sessionId,
  onImage,
}: {
  item: Extract<TranscriptItem, { kind: 'user' }>;
  sessionId: string;
  onImage: (src: string) => void;
}) {
  const { hovered, ref } = useHover<HTMLDivElement>();
  const clipboard = useClipboard({ timeout: 1500 });
  /** The action awaiting confirmation, or null when the dialog is closed. */
  const [confirming, setConfirming] = useState<RewindIntent | null>(null);
  /** No earlier assistant reply to fork the CLI conversation at, so a rewind here
   *  clears Claude's memory of the session outright. Said in the dialog rather
   *  than done silently. */
  const [fullReset, setFullReset] = useState(false);
  // A primitive (the reason string, or null) rather than the meta object: this
  // selector runs on every store change and every user bubble holds one, so
  // returning anything with a fresh identity would re-render the whole transcript.
  const blockReason = useStore((s) => {
    const meta = s.sessions[sessionId];
    if (!meta) return 'That session is gone.';
    if (s.connectionStatus !== 'connected') return 'Reconnecting…';
    return rewindBlock(meta)?.reason ?? null;
  });
  // A boolean, for the same reason the block reason is a string: a stable
  // selector result keeps this bubble out of unrelated re-renders.
  const inWorkflow = useStore((s) => s.sessions[sessionId]?.workflow?.started === true);
  const seq = Number(item.key.slice(1));

  const openConfirm = (intent: RewindIntent) => {
    // Read at click time, not subscribed: the transcript changes on every event
    // and this is needed once, for one line of dialog copy.
    const events = useStore.getState().transcripts[sessionId] ?? [];
    setFullReset(
      !events.some((e) => {
        if (e.seq >= seq || e.kind !== 'sdk') return false;
        const d = e.data as { type?: string; uuid?: string } | null;
        return d?.type === 'assistant' && !!d.uuid;
      }),
    );
    setConfirming(intent);
  };

  /** Shared by both actions: what is deleted is identical, and only the fate of
   *  this message's own text differs. Both sentences say "deleted" rather than
   *  "rewound to" — the ambiguity being avoided is whether the message survives. */
  const lostCopy =
    'Every reply and prompt after it is deleted too, and Claude forgets those turns. ' +
    'This cannot be undone, and what the deleted turns already cost is not refunded.' +
    (inWorkflow
      ? ' The workflow goes back to the step this message belongs to and waits there; later steps and anything they published are discarded.'
      : '') +
    (fullReset
      ? " There is no earlier reply to go back to, so Claude's memory of this session is cleared completely."
      : '');

  /** Icon-only, so the tooltip carries the whole explanation — and it has to say
   *  what is *deleted*, since both actions truncate and only Edit gives the text
   *  back. A blocked action shows the block reason there instead, rather than
   *  leaving a dead button unexplained. `label` is the short name, for screen
   *  readers and nothing else. */
  const action = (intent: RewindIntent, Icon: typeof IconPencil, label: string, hint: string) => (
    <Tooltip label={blockReason ?? hint} key={intent}>
      {/* A span so the tooltip still fires over a disabled control. */}
      <span style={{ display: 'inline-flex' }}>
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          aria-label={label}
          disabled={blockReason !== null}
          onClick={() => openConfirm(intent)}
        >
          <Icon size={14} />
        </ActionIcon>
      </span>
    </Tooltip>
  );

  return (
    <Stack ref={ref} gap={6} align="flex-end">
      {/* width: 100% is load-bearing: the outer Stack's align="flex-end" would
          otherwise shrink this row to fit, and the bubble's maxWidth: 80% below
          would resolve against the text's own width instead of the column. */}
      <Box
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 6,
          alignItems: 'flex-end',
          width: '100%',
        }}
      >
        <Paper
          radius="md"
          px="sm"
          py={6}
          bg="var(--mantine-color-default-hover)"
          // maxWidth: 80% resolves against the full-width row above, so the
          // bubble caps at 80% of the transcript column and hugs its text below
          // that. minWidth: 0 is load-bearing twice — it stops a wide code block
          // from growing the flex item, and since used width is
          // max(min-width, min(max-width, width)), a default min-width: auto
          // (min-content) would beat maxWidth: 80% for one long unbreakable token.
          style={{ maxWidth: '80%', minWidth: 0, overflowWrap: 'anywhere' }}
        >
          {item.text && <UserText text={item.text} />}
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
              {item.attachments.map((att) => (
                <AttachmentTile key={att.url} att={att} onImage={onImage} />
              ))}
            </Group>
          )}
        </Paper>
        <PromptAuthor actor={item.actor} ts={item.ts} />
      </Box>
      {/* Under the bubble, right-aligned so it sits beneath the avatar. The row
          keeps its height when hidden: revealing it on hover must not shift the
          transcript under the pointer. */}
      <Group
        gap={4}
        h={28}
        pr={30}
        justify="flex-end"
        style={{
          opacity: hovered || confirming ? 1 : 0,
          transition: 'opacity 120ms',
          pointerEvents: hovered || confirming ? 'auto' : 'none',
        }}
      >
        <Tooltip label={clipboard.copied ? 'Copied' : 'Copy message'}>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label="Copy message"
            // Never gated: reading your own text back is not a session action.
            onClick={() => clipboard.copy(item.text)}
          >
            {clipboard.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </ActionIcon>
        </Tooltip>
        {action(
          'edit',
          IconPencil,
          'Edit',
          'Edit and resend — deletes this message and everything after it, and puts its text back in the composer',
        )}
        {action(
          'rewind',
          IconArrowBackUp,
          'Delete from here',
          'Delete this message and everything after it — the text is not kept',
        )}
      </Group>
      <ConfirmModal
        opened={confirming !== null}
        title={confirming === 'rewind' ? 'Delete from this message?' : 'Edit this message?'}
        message={
          confirming === 'rewind'
            ? `This message is deleted and its text is not kept. ${lostCopy}`
            : `This message is deleted, but its text comes back in the composer to edit and send again. ${lostCopy}`
        }
        confirmLabel={confirming === 'rewind' ? 'Delete' : 'Edit'}
        confirmColor="red"
        onConfirm={() => {
          const edit = confirming === 'edit';
          setConfirming(null);
          send({ type: 'rewindSession', sessionId, seq, edit });
        }}
        onCancel={() => setConfirming(null)}
      />
    </Stack>
  );
}

/**
 * A queued prompt the user sent into the turn that was already running.
 *
 * Deliberately not a {@link UserBubble}. It is human-authored, so it keeps the
 * right alignment and the avatar — but it is *outlined rather than filled*,
 * because the filled bubble means "this opened a turn" and this did not. It is
 * also not a rewind anchor: rewindSession truncates from a `kind:'user'` seq, and
 * there is nothing mid-turn to go back to. So no Edit, no Delete from here —
 * copy is the only action, the same one UserBubble never gates.
 */
function InterjectionRow({ item }: { item: Extract<TranscriptItem, { kind: 'interject' }> }) {
  const { hovered, ref } = useHover<HTMLDivElement>();
  const clipboard = useClipboard({ timeout: 1500 });
  return (
    <Stack ref={ref} gap={2} align="flex-end">
      {/* Same width: 100% trick as UserBubble — the outer align="flex-end" would
          otherwise resolve maxWidth against the text's own width. */}
      <Box
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 6,
          alignItems: 'flex-end',
          width: '100%',
        }}
      >
        {/* Outside the bubble, so the bubble holds only what the user wrote. The
            whole explanation lives in its tooltip — measured, not guessed: the
            model reads it on its next inference, after the tool call that was
            already running returns. Promising anything faster would have someone
            watch a 3-minute Bash and think it was lost. */}
        <Tooltip label="Sent into this turn — Claude reads it after the current step">
          <IconBolt size={14} style={{ flexShrink: 0, marginBottom: 5, opacity: 0.6 }} />
        </Tooltip>
        <Paper
          radius="md"
          px="sm"
          py={4}
          withBorder
          bg="transparent"
          style={{ maxWidth: '80%', minWidth: 0, overflowWrap: 'anywhere' }}
        >
          <UserText text={item.text} />
          {item.mentions && item.mentions.length > 0 && (
            <Group gap={6} mt={6}>
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
        </Paper>
        <PromptAuthor actor={item.actor} ts={item.ts} />
      </Box>
      {/* Under the bubble and right-aligned, as UserBubble's actions are. Keeps its
          height when hidden: revealing it on hover must not shift the transcript
          under the pointer. */}
      <Group
        gap={4}
        h={24}
        pr={30}
        justify="flex-end"
        style={{
          opacity: hovered ? 1 : 0,
          transition: 'opacity 120ms',
          pointerEvents: hovered ? 'auto' : 'none',
        }}
      >
        <Tooltip label={clipboard.copied ? 'Copied' : 'Copy message'}>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label="Copy message"
            onClick={() => clipboard.copy(item.text)}
          >
            {clipboard.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </ActionIcon>
        </Tooltip>
      </Group>
    </Stack>
  );
}

/**
 * One transcript row. Memoized: {@link reconcileItems} hands unchanged items back
 * across rebuilds, so with stable props an untouched row skips reconciliation
 * entirely — which is the whole point of the structural sharing upstream.
 */
const Item = memo(function Item({
  item,
  sessionId,
  onImage,
  renderNested,
  retryKey,
  activeGroupKey,
  activeTurnKey,
}: {
  item: TranscriptItem;
  sessionId: string;
  onImage: (src: string) => void;
  /** Renders a subagent's items inside a Task card. Owned by Transcript so it stays
   *  referentially stable — a fresh closure would defeat ToolGroup's memo. */
  renderNested: (items: TranscriptItem[]) => ReactNode;
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
      // Right-aligned even for a peer's prompt, deliberately: agent output is
      // flush-left by established convention, so a left-aligned peer bubble
      // would read as the agent talking. Authorship is carried by the avatar
      // and its colour instead of by side.
      return <UserBubble item={item} sessionId={sessionId} onImage={onImage} />;
    case 'interject':
      return <InterjectionRow item={item} />;
    case 'assistant':
      // Agent output is unwrapped and flush-left — no bubble, no icon gutter.
      return (
        <Stack gap={6} style={{ minWidth: 0 }}>
          {item.blocks.map((block, i) => {
            if (block.type === 'text') return <Markdown key={i} text={block.text} />;
            return (
              <Text
                key={i}
                size="xs"
                c="dimmed"
                fs="italic"
                // pre-wrap keeps the author's line breaks but still cannot break an
                // unbroken token, so it needs the wrap guard of its own.
                style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                {block.text.length > 600 ? block.text.slice(0, 600) + '…' : block.text}
              </Text>
            );
          })}
        </Stack>
      );
    case 'tool-group':
      return (
        <ToolGroup
          group={item}
          active={!!isActiveGroup}
          sessionId={sessionId}
          // A subagent's items are rendered by this same component; passing the
          // renderer down avoids an import cycle (Transcript → ToolGroup → card).
          renderNested={renderNested}
        />
      );
    case 'agent-turn':
      return (
        <AgentTurn
          turn={item}
          active={item.key === activeTurnKey}
          sessionId={sessionId}
          onImage={onImage}
          renderNested={renderNested}
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
        <Stack gap={2} align="center">
          <Group gap="xs" justify="center">
            <Text size="xs" c={item.isError ? 'red' : 'dimmed'} ta="center">
              {/* A stopped turn is the user's own doing, not a failure: neutral, and
                  Retry drops out on its own because `isError` is false. A recovering
                  one reads neutrally for the same reason — the turn is still going,
                  the bridge is just sending it again. */}
              {item.recovering
                ? 'retrying…'
                : item.stopped
                  ? 'turn stopped'
                  : item.isError
                    ? 'turn failed'
                    : 'turn done'}
              {item.costUsd != null ? ` · $${item.costUsd.toFixed(4)}` : ''}
              {item.durationMs != null ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ''}
            </Text>
            {showRetry && <FailedTurnActions sessionId={sessionId} />}
          </Group>
          {/* The durable record of why: SessionView's alert vanishes on the next prompt. */}
          {item.error && (
            <Text
              size="xs"
              c="red"
              opacity={0.75}
              ta="center"
              lineClamp={3}
              style={{ overflowWrap: 'anywhere' }}
            >
              {item.error}
            </Text>
          )}
        </Stack>
      );
    case 'permission':
      // Auto-allowed calls are filtered out upstream; only real prompts reach here.
      return <PermissionPrompt sessionId={sessionId} data={item.data} resolution={item.resolution} />;
    case 'workflow':
      return <WorkflowMarker data={item.data} />;
    case 'context-compact':
      return <ContextCompactMarker data={item.data} />;
    case 'task':
      // One dimmed row in the same register as session-init, and only for an orphan —
      // a task whose launching tool card is known renders as state on that card
      // instead. Clamped to one line: a `summary` can be the whole backgrounded
      // script, and a centered dimmed one-liner is the register this row is in.
      return (
        <Text
          size="xs"
          c={item.outcome?.status === 'failed' ? 'red' : 'dimmed'}
          ta="center"
          lineClamp={1}
          // lineClamp truncates lines, not a token too wide to fit on one.
          style={{ overflowWrap: 'anywhere' }}
        >
          background task
          {item.outcome ? ` ${item.outcome.status}` : ''}
          {' · '}
          {item.outcome?.summary || item.description || item.subagentType || 'running'}
        </Text>
      );
  }
});

/**
 * A permission item whose tool card already says everything it would.
 *
 * Auto-allowed calls never had anything to show. An *answered* `AskUserQuestion` is
 * the same case since its tool card renders the questions with the chosen options
 * still selected — the resolved prompt underneath repeated the question and answer a
 * second time. Denied and expired ones stay: their copy ("re-send your prompt and
 * Claude will ask again") exists nowhere else.
 */
function isRedundant(item: { data: PermissionRequestData; resolution?: string }): boolean {
  if (item.data.auto) return true;
  return item.data.toolName === 'AskUserQuestion' && item.resolution === 'allow';
}

// Sticky per-turn override (Compact level), keyed `${sessionId}:${turn.key}`. Module scope
// so it survives Transcript remount and rebuilds; `t*` keys never collide with `g*` groups.
const turnOverrides = new Map<string, boolean>();

const AgentTurn = memo(function AgentTurn({
  turn,
  active,
  sessionId,
  onImage,
  renderNested,
  retryKey,
  activeGroupKey,
}: {
  turn: AgentTurnItem;
  active: boolean;
  sessionId: string;
  onImage: (src: string) => void;
  renderNested: (items: TranscriptItem[]) => ReactNode;
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
  // Walks every tool call in the turn (and diffs the edits) — recomputing it on
  // an unrelated re-render is pure waste; `turn.items` is rebuilt only when the
  // transcript itself changes.
  const { narrative, narration, summary, totals, result } = useMemo(
    () => turnToolStats(turn.items),
    [turn.items],
  );
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
      {/* Only the open turn renders its children. A folded turn holds the whole
          turn — assistant markdown, tool groups, results — and on a long
          transcript nearly every turn is folded on first paint. */}
      <Collapse expanded={expanded} transitionDuration={150}>
        {expanded && (
          <Stack gap={6} mt={4}>
            {turn.items.map((child) => (
              <Item
                key={child.key}
                item={child}
                sessionId={sessionId}
                onImage={onImage}
                renderNested={renderNested}
                retryKey={retryKey}
                activeGroupKey={activeGroupKey}
              />
            ))}
          </Stack>
        )}
      </Collapse>
    </Box>
  );
});

/** Top-level items rendered on first paint, and the size of each backfill step. */
const INITIAL_WINDOW = 40;

/**
 * How long after a scroll gesture follow-the-stream stays out of the way. A
 * wheel notch or trackpad flick moves ~10px, well inside onScroll's 60px
 * near-bottom tolerance, so a single event can't unpin; the distance has to
 * accumulate across the gesture, which it can't if the autoscroll resets it to
 * zero between events. Spans the gaps between events in one deliberate gesture
 * (trackpad inertia is continuous; a slow hand-rolled scroll is not).
 */
const GESTURE_HOLD_MS = 500;

/** Keys that move the viewport, so pressing one counts as a scroll gesture. */
const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
]);

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
  // Previous built/folded lists, so a rebuild can hand back the objects it didn't
  // change (see reconcileItems). Refs, not state: this is a cache keyed by the
  // very inputs the memo below is keyed on, so writing it during render is idempotent.
  const builtRef = useRef<TranscriptItem[]>([]);
  const foldedRef = useRef<TranscriptItem[]>([]);
  // Flat item list. Full level ('full') leaves tools ungrouped (1-tool groups render bare);
  // otherwise consecutive tools fold into tool-groups. Auto-allowed permission one-liners
  // are redundant (their tool shows in the group card) so drop them; real prompts stay.
  const { built, live } = useMemo(() => {
    const { items, live } = buildTranscript(events, compactionLevel !== 'full');
    const kept = items.filter((it) => !(it.kind === 'permission' && isRedundant(it)));
    builtRef.current = reconcileItems(builtRef.current, kept);
    return { built: builtRef.current, live };
  }, [events, compactionLevel]);
  // Compact level additionally folds each agent turn into a collapsible super-group.
  // The fold allocates fresh agent-turn wrappers around already-reused children, so
  // it needs its own reconcile pass.
  const items = useMemo(() => {
    if (compactionLevel !== 'compact') return built;
    foldedRef.current = reconcileItems(foldedRef.current, foldAgentTurns(built));
    return foldedRef.current;
  }, [built, compactionLevel]);
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
      // 'user' only, never 'interject': an interjection joins the turn that is
      // already running, so the elapsed clock must keep counting from its prompt.
      if (events[i].kind === 'user') return events[i].ts;
    }
    return undefined;
  }, [turnStartedAt, events]);
  // Retry only on the trailing failed result of a settled session — a retry
  // button mid-history or during a running turn would be stale/confusing.
  // Use the flat list so it's found even when the result is folded into a turn.
  // A workflow park marker or a compaction row can land *after* the result without
  // meaning the turn moved on, so scan past those two kinds only: everything else
  // (a live permission card, or any content of a new turn) ends the scan.
  let trailing: TranscriptItem | undefined;
  for (let n = built.length - 1; n >= 0; n--) {
    const item = built[n]!;
    if (item.kind === 'workflow' || item.kind === 'context-compact') continue;
    trailing = item;
    break;
  }
  const retryKey =
    trailing?.kind === 'result' &&
    trailing.isError &&
    status !== 'running' &&
    status !== 'waiting-permission'
      ? trailing.key
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
  // so a collapse/expand doesn't get mistaken for a user scrolling up. It is
  // immunity for *browser-initiated* scrolls only and must never outlast the
  // user: a real gesture clears it (see the scrollShellRef listener below), so
  // follow-the-stream can't hold the view down through a resize burst that
  // never lapses while a turn streams.
  const suppressUnpinUntilRef = useRef(0);
  // While > now, a scroll gesture is in progress and nothing follows the stream:
  // the user's scrolling has to be free to move the view away from the bottom
  // before onScroll can see it as an unpin. See GESTURE_HOLD_MS.
  const gestureUntilRef = useRef(0);
  // ScrollArea shell, not the viewport: a scrollbar-thumb drag lands on a
  // sibling of the viewport, so a viewport-only listener would miss it.
  const scrollShellRef = useRef<HTMLDivElement>(null);

  // ToolGroup / ToolCallCard are memoized, so the nested renderer has to keep one
  // identity across commits or their memo does nothing. It reaches itself through
  // a ref because a subagent's transcript can hold further Task cards.
  const renderNestedRef = useRef<(nested: TranscriptItem[]) => ReactNode>(() => null);
  const renderNested = useCallback(
    (nested: TranscriptItem[]) =>
      nested.map((child) => (
        <Item
          key={child.key}
          item={child}
          sessionId={sessionId}
          onImage={setLightbox}
          renderNested={renderNestedRef.current}
        />
      )),
    [sessionId],
  );
  renderNestedRef.current = renderNested;

  // Tail window. A cold mount of a long session commits every row in one
  // synchronous pass — the visible freeze on a session switch. Render the tail
  // first and backfill on idle until the list is whole.
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW);
  const hidden = Math.max(0, items.length - windowSize);
  const visibleItems = hidden > 0 ? items.slice(hidden) : items;
  // Which workflow steps have started, read off the item list rather than the
  // rendered [data-workflow-step] markers — the list is complete even while the
  // window is clipping, so the progress bar stays right on a workflow session.
  const startedSteps = useMemo(() => {
    const set = new Set<number>();
    for (const it of items) {
      if (it.kind === 'workflow' && it.data.event === 'started') set.add(it.data.stepIndex);
    }
    return set;
  }, [items]);
  // Set just before the window grows: the rows that appear above the viewport
  // would otherwise push the content down and jump the view.
  const anchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  const showEarlier = () => {
    const el = viewportRef.current;
    if (el) anchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    setWindowSize((n) => n + INITIAL_WINDOW);
  };

  // The stepper asked for a step whose start marker is still outside the window.
  // Drop the window and scroll to it once it has mounted (below).
  const [revealStep, setRevealStep] = useState<number | null>(null);
  useEffect(() => {
    const onReveal = (e: Event) => {
      const step = (e as CustomEvent<number>).detail;
      // Already mounted in *this* viewport: scroll straight to it. Growing the
      // window would remount the whole transcript for a jump that needs no
      // extra rows. Unpin first, or a live turn's autoscroll fights the
      // animation and snaps the view back to the bottom.
      const marker = viewportRef.current?.querySelector(`[data-workflow-step="${step}"]`);
      if (marker) {
        pinnedRef.current = false;
        suppressUnpinUntilRef.current = 0;
        marker.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      setWindowSize(Number.MAX_SAFE_INTEGER);
      setRevealStep(step);
    };
    window.addEventListener(REVEAL_STEP_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_STEP_EVENT, onReveal);
  }, []);
  useEffect(() => {
    if (revealStep == null) return;
    const marker = viewportRef.current?.querySelector(`[data-workflow-step="${revealStep}"]`);
    if (!marker) return;
    setRevealStep(null);
    // Not smooth: the window just grew by hundreds of rows, so an animated scroll
    // would race the reflow.
    marker.scrollIntoView({ block: 'start' });
    pinnedRef.current = false;
    suppressUnpinUntilRef.current = 0;
  }, [revealStep, visibleItems]);

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
    // Which steps ran comes from the item list, not from the DOM: the tail window
    // clips earlier markers away, and a clipped step is a step that already ran.
    const started = new Array<boolean>(n).fill(false);
    started[0] = true; // pre-marker content belongs to step 1
    const bounds = new Array<number>(n + 1).fill(maxScroll);
    bounds[0] = 0;
    if (n > 1) {
      for (const i of startedSteps) if (i >= 0 && i < n) started[i] = true;
      const placed = new Array<boolean>(n + 1).fill(false);
      placed[0] = true;
      const viewportTop = el.getBoundingClientRect().top;
      el.querySelectorAll<HTMLElement>('[data-workflow-step]').forEach((marker) => {
        const i = Number(marker.dataset.workflowStep);
        if (i > 0 && i < n) {
          placed[i] = true;
          bounds[i] = Math.min(
            maxScroll,
            marker.getBoundingClientRect().top - viewportTop + el.scrollTop,
          );
        }
      });
      // A step that ran but whose marker is above the window starts at the very
      // top: all of its content is off the list, so scrolling past it is done.
      for (let i = 1; i < n; i++) if (started[i] && !placed[i]) bounds[i] = 0;
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
    // Reached the bottom on purpose (the "new content" button) — resume
    // following now rather than after the gesture hold lapses.
    gestureUntilRef.current = 0;
  };

  /** Follow-the-stream stands down while the user is working the scroller. */
  const following = () => pinnedRef.current && Date.now() >= gestureUntilRef.current;

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
    // Reaching the top of a clipped list is a request for more of it.
    if (hidden > 0 && el.scrollTop < 200) showEarlier();
    updateProgress();
  };

  // Backfill the window after first paint, one step per idle slot, so find-in-page
  // and the progress bar converge to the complete list.
  useEffect(() => {
    if (hidden === 0) return;
    const idle = typeof requestIdleCallback === 'function';
    const handle = idle ? requestIdleCallback(showEarlier) : setTimeout(showEarlier, 200);
    return () => {
      if (idle) cancelIdleCallback(handle as number);
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden]);

  // Hold the viewport still across a window growth. Must run before the [items]
  // effect's pin check, hence layout: the rows are already laid out, not painted.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    anchorRef.current = null;
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  }, [visibleItems]);

  useEffect(() => {
    if (following()) {
      scrollToBottom();
    } else if (!pinnedRef.current && items.length > 0) {
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
      if (following()) {
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

  // A streaming turn resizes the content on nearly every frame, so the 200ms
  // immunity window above is re-armed faster than it can lapse and onScroll
  // never gets to unpin. A gesture revokes that window *and* holds off
  // follow-the-stream for GESTURE_HOLD_MS, which is the part that makes a
  // gentle scroll work: without it the autoscroll returns the view to the
  // bottom between events, so the distance never crosses onScroll's 60px
  // tolerance and only one aggressive flick could ever escape. Pin/unpin policy
  // itself stays in onScroll. Capture phase so a nested scroller (a table wrap,
  // a code block) or a stopPropagation inside a row can't hide the gesture.
  useEffect(() => {
    const shell = scrollShellRef.current;
    if (!shell) return;
    const hold = () => {
      suppressUnpinUntilRef.current = 0;
      gestureUntilRef.current = Date.now() + GESTURE_HOLD_MS;
    };
    // Upward only: a wheel-down is either a no-op at the bottom or a move
    // toward it, and holding follow off for it would stall the stream for
    // GESTURE_HOLD_MS and then jump. Also skips a table's horizontal scroll.
    const onWheel = (e: Event) => {
      if ((e as WheelEvent).deltaY < 0) hold();
    };
    // A press outside the viewport is the scrollbar (the thumb is a sibling of
    // it); inside is a row's own control, and a chevron click must still leave
    // the turn's Collapse animation glued to the bottom.
    const onPointerDown = (e: Event) => {
      if (!viewportRef.current?.contains(e.target as Node)) hold();
    };
    // Only keys that scroll — a transcript row can hold a text input, and
    // typing in one is not a request to stop following.
    const onKeyDown = (e: Event) => {
      if (SCROLL_KEYS.has((e as KeyboardEvent).key)) hold();
    };
    const opts = { capture: true, passive: true } as const;
    shell.addEventListener('wheel', onWheel, opts);
    shell.addEventListener('touchmove', hold, opts);
    shell.addEventListener('pointerdown', onPointerDown, opts);
    shell.addEventListener('keydown', onKeyDown, opts);
    return () => {
      shell.removeEventListener('wheel', onWheel, { capture: true });
      shell.removeEventListener('touchmove', hold, { capture: true });
      shell.removeEventListener('pointerdown', onPointerDown, { capture: true });
      shell.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, []);

  return (
    <Box ref={scrollShellRef} style={{ flex: 1, position: 'relative', minHeight: 0 }}>
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
          {/* Truthful about the clipping, and the only affordance a keyboard user
              has while the idle backfill is still catching up. */}
          {hidden > 0 && (
            <Button variant="subtle" size="compact-xs" onClick={showEarlier}>
              Show earlier messages ({hidden})
            </Button>
          )}
          {visibleItems.map((item) => (
            <Item
              key={item.key}
              item={item}
              sessionId={sessionId}
              onImage={setLightbox}
              renderNested={renderNested}
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
