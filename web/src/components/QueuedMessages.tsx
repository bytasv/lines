import { useRef, useState } from 'react';
import {
  ActionIcon,
  Avatar,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconBolt, IconPaperclip, IconPencil, IconX } from '@tabler/icons-react';
import type {
  Attachment,
  MentionValue,
  PromptAttachment,
  QueuedPrompt,
  SessionMeta,
} from '@lines/shared';
import { rootsForCwd } from '@lines/shared';
import { sessionCaps } from '../lib/capabilities';
import { buildExpandedPrompt, mentionKindMeta, uniqueMentions } from '../lib/mentions';
import { useCan } from '../lib/can';
import { useIdentityResolver } from '../lib/identity';
import { useStore } from '../store';
import { send } from '../ws';
import { fileToAttachment } from './Composer';
import { MentionInput } from './MentionInput';

/**
 * The author of one queued prompt.
 *
 * Rendered only when it is not yours: on a solo machine every queued item is
 * your own and an avatar per row would be pure noise. The moment somebody else's
 * prompt is sitting in the queue, whose it is becomes the point.
 */
function QueuedAuthor({
  item,
  identify,
}: {
  item: QueuedPrompt;
  identify: ReturnType<typeof useIdentityResolver>;
}) {
  // No actor means the machine's own owner wrote it — the same fallback the
  // transcript uses, so a queued prompt and the bubble it becomes agree.
  const who = identify(item.actor?.userId, item.actor);
  if (who.self) return null;
  return (
    <Tooltip label={`Queued by ${who.name} — waiting for you to send it`} withArrow openDelay={200}>
      <Avatar
        src={who.imageUrl ?? undefined}
        size={18}
        radius="xl"
        color={who.color}
        variant="filled"
        style={{ flexShrink: 0 }}
      >
        <Text size="9px" fw={700}>
          {who.initials}
        </Text>
      </Avatar>
    </Tooltip>
  );
}

/** The @mention badges of a queued prompt — the same chips the transcript bubble shows. */
function MentionBadges({ mentions }: { mentions: QueuedPrompt['mentions'] }) {
  if (!mentions?.length) return null;
  return (
    <Group gap={4}>
      {mentions.map((m) => {
        const meta = mentionKindMeta[m.kind];
        const Icon = meta?.icon;
        return (
          <Badge
            key={`${m.kind}:${m.id}`}
            size="xs"
            variant="light"
            color={meta?.color ?? 'gray'}
            leftSection={Icon ? <Icon size={10} /> : undefined}
            style={{ textTransform: 'none' }}
          >
            {m.label}
          </Badge>
        );
      })}
    </Group>
  );
}

/**
 * A queued prompt reopened in a real composer — text with mention pills, plus
 * its attachments.
 *
 * Seeded from `item.draft` (the pre-expansion text the composer sent) and only
 * from `item.text` when there is none: an item queued by an older build, or one
 * with no mentions, where the two are the same string anyway. Saving re-runs the
 * exact expansion `Composer.submit` does, so the flushed prompt carries the
 * expansion block once, not twice.
 */
function QueuedEditor({
  session,
  item,
  gone,
  onClose,
}: {
  session: SessionMeta;
  item: QueuedPrompt;
  /** The turn settled and this item flushed while the editor was open. */
  gone: boolean;
  onClose: () => void;
}) {
  const projects = useStore((s) => s.projects);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState<MentionValue>(item.draft ?? { text: item.text, ranges: [] });
  const [kept, setKept] = useState<Attachment[]>(item.attachments ?? []);
  const [added, setAdded] = useState<PromptAttachment[]>([]);

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const encoded = await Promise.all(list.map(fileToAttachment));
    setAdded((a) => [...a, ...encoded]);
  };

  const text = value.text.trim();
  const cannotSave = gone || (!text && kept.length === 0 && added.length === 0);

  const save = () => {
    if (cannotSave) return;
    // The same four lines as Composer.submit: the expansion is baked into the
    // text, `mentions` rides along display-only.
    const expanded = buildExpandedPrompt(text, value.ranges);
    const wireMentions = uniqueMentions(value.ranges).map(({ kind, id, label, detail }) => ({
      kind,
      id,
      label,
      detail,
    }));
    // A delta of urls, matched server-side against this item's own refs.
    const dropped = (item.attachments ?? [])
      .filter((a) => !kept.some((k) => k.url === a.url))
      .map((a) => a.url);
    send({
      type: 'editQueued',
      sessionId: session.id,
      queuedId: item.id,
      text: expanded,
      mentions: wireMentions.length ? wireMentions : undefined,
      // Written back so a second edit still opens with its pills.
      draft: value.ranges.length ? value : undefined,
      addAttachments: added.length ? added : undefined,
      removeAttachments: dropped.length ? dropped : undefined,
    });
    onClose();
  };

  return (
    <Stack
      gap={6}
      // Escape closes the editor — unless MentionInput already consumed it to
      // dismiss its own popover.
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) onClose();
      }}
    >
      {gone && (
        // The queue flushed underneath us. Said, not silently swallowed: the
        // typing is still on screen to copy out of.
        <Text size="xs" c="orange">
          This prompt was already sent — your changes were not saved.
        </Text>
      )}
      <MentionInput
        value={value}
        onChange={setValue}
        onSubmit={save}
        cwd={session.cwd}
        roots={rootsForCwd(projects, session.cwd)}
        placeholder="Edit this queued prompt…"
        textareaRef={textareaRef}
        onPasteFiles={(files) => void addFiles(files)}
      />
      {(kept.length > 0 || added.length > 0) && (
        <Group gap={4}>
          {kept.map((att) => (
            <Badge
              key={att.url}
              size="xs"
              variant="light"
              color="gray"
              rightSection={
                <IconX
                  size={10}
                  style={{ cursor: 'pointer', display: 'block' }}
                  onClick={() => setKept((a) => a.filter((k) => k.url !== att.url))}
                />
              }
            >
              {att.name}
            </Badge>
          ))}
          {added.map((att, i) => (
            <Badge
              key={`new:${i}`}
              size="xs"
              variant="light"
              color="blue"
              rightSection={
                <IconX
                  size={10}
                  style={{ cursor: 'pointer', display: 'block' }}
                  onClick={() => setAdded((a) => a.filter((_, j) => j !== i))}
                />
              }
            >
              {att.name}
            </Badge>
          ))}
        </Group>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.currentTarget.files) void addFiles(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
      <Group gap="xs">
        <Tooltip label="Attach files">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            disabled={gone}
            onClick={() => fileInputRef.current?.click()}
          >
            <IconPaperclip size={14} />
          </ActionIcon>
        </Tooltip>
        <Button size="compact-xs" onClick={save} disabled={cannotSave}>
          Save
        </Button>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={onClose}>
          {gone ? 'Close' : 'Cancel'}
        </Button>
      </Group>
    </Stack>
  );
}

/** Prompts held server-side while the session is busy; sent FIFO after each turn. */
export function QueuedMessages({ session }: { session: SessionMeta }) {
  const queued = session.queued;
  const identify = useIdentityResolver();
  const canPrompt = useCan('prompt');
  const caps = sessionCaps(session);
  // Our own machine — the owner may rewrite anything in the queue, which is the
  // whole point of reviewing a guest's prompt before releasing it.
  const isOwnerView = useStore((s) => s.access === null);
  // Our own prompts need the host's approval — so the queue is waiting on them,
  // not on us.
  const needsApproval = useStore((s) => s.access?.caps.promptNeedsApproval === true);
  const ownerName = useStore(
    (s) => s.access?.ownerProfile?.name ?? s.access?.ownerProfile?.email ?? 'the owner',
  );
  // The item under edit, with a snapshot so a flush mid-edit can keep the
  // editor on screen instead of yanking it away.
  const [editing, setEditing] = useState<{ id: string; snapshot: QueuedPrompt } | null>(null);
  // Distinct names of everyone other than you with a prompt in this queue.
  const othersWaiting = [
    ...new Set(
      (queued ?? [])
        .map((item) => identify(item.actor?.userId, item.actor))
        .filter((who) => !who.self)
        .map((who) => who.name),
    ),
  ];
  // Keyed by item id, so the orphaned editor keeps its React state when the row
  // it was rendered in moves to the end of the list.
  const orphaned = editing && !queued?.some((q) => q.id === editing.id) ? editing.snapshot : null;
  const rows = [...(queued ?? []), ...(orphaned ? [orphaned] : [])];
  if (!rows.length) return null;

  return (
    <Stack gap={6} maw={920} mx="auto" w="100%" px="md" pb={4}>
      <Group gap="xs">
        <Text size="xs" c="dimmed" fw={600}>
          Queued · {queued?.length ?? 0}
        </Text>
        {session.queuePaused && (
          <Badge size="xs" color="yellow" variant="light">
            {/* Named when somebody else is waiting on you: "paused" alone does not
                say that a colleague's prompt is sitting there, unable to run
                until you send something. */}
            {needsApproval
              ? // A guest whose prompts land paused: sending another one does NOT
                // resume the queue, so promising that would have them typing into
                // a queue that never moves.
                `waiting for ${ownerName} to send it`
              : othersWaiting.length
                ? `waiting for you · from ${othersWaiting.join(', ')}`
                : 'paused — sending a message resumes'}
          </Badge>
        )}
      </Group>
      {rows.map((item) => {
        const who = identify(item.actor?.userId, item.actor);
        // Yours to fix, or the owner's to review. The cap is `prompt`, not the
        // `interrupt` the X uses — see MESSAGE_AUTHZ.editQueued.
        const canEdit = canPrompt && (who.self || isOwnerView);
        const editor = identify(item.editedBy?.userId, item.editedBy);
        // Only while a turn is actually running: with nothing to interject into,
        // a button that silently degraded into an ordinary send would be worse
        // than no button. The two near-miss cases are disabled rather than
        // hidden, so the rule is learnable from the tooltip.
        // Only where the engine can be steered mid-turn. Hidden, not disabled:
        // with no steering there is no state the user could reach that would
        // enable it.
        const showSendNow = canPrompt && session.status === 'running' && caps.interject;
        const sendNowBlocked = item.attachments?.length
          ? // Refused server-side in v1: the staged files would have to be
            // re-read into a multi-block content array mid-turn.
            'Attachments send after this turn.'
          : needsApproval
            ? `Only ${ownerName} can send this now.`
            : null;
        return (
          <Paper
            key={item.id}
            p="xs"
            radius="md"
            style={{ border: '1px dashed var(--mantine-color-default-border)' }}
          >
            {editing?.id === item.id ? (
              <QueuedEditor
                session={session}
                item={item}
                gone={item === orphaned}
                onClose={() => setEditing(null)}
              />
            ) : (
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <Stack gap={4} style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="nowrap">
                    {/* Who wrote it, not who releases it. With `promptNeedsApproval`
                        this list is somebody else's work waiting on your approval to
                        run on your machine, as you — so the author is the first thing
                        you need, before the text. */}
                    <QueuedAuthor item={item} identify={identify} />
                    <Text size="sm" c="dimmed" lineClamp={2}>
                      {item.text}
                    </Text>
                    {item.editedAt && (
                      // Only stamped when somebody other than the author rewrote
                      // it — the prompt still runs as the author, so the rewrite
                      // must not be invisible.
                      <Tooltip
                        label={`Edited by ${editor.name}`}
                        withArrow
                        openDelay={200}
                      >
                        <Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
                          edited
                        </Badge>
                      </Tooltip>
                    )}
                  </Group>
                  <MentionBadges mentions={item.mentions} />
                  {!!item.attachments?.length && (
                    <Group gap={4}>
                      {item.attachments.map((att) => (
                        <Badge key={att.url} size="xs" variant="light" color="gray">
                          {att.name}
                        </Badge>
                      ))}
                    </Group>
                  )}
                </Stack>
                {/* Order is the danger ranking: Send now is the only one of the
                    three that reaches the model, so it leads. */}
                <Group gap={2} wrap="nowrap">
                  {showSendNow && (
                    <Tooltip
                      label={
                        // Measured latency, not a promise of instant delivery: the
                        // model picks it up on its next inference, once the step
                        // that is already running finishes.
                        sendNowBlocked ??
                        'Send now — Claude reads it once the current step finishes'
                      }
                      withArrow
                      openDelay={300}
                    >
                      {/* A span so the tooltip still fires over a disabled control. */}
                      <span style={{ display: 'inline-flex' }}>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size="sm"
                          aria-label="Send now"
                          disabled={sendNowBlocked !== null}
                          // No optimistic removal, matching the X and the editor:
                          // the row goes when `sessionUpsert` lands, and a refusal
                          // leaves it exactly where it was.
                          onClick={() =>
                            send({
                              type: 'interjectQueued',
                              sessionId: session.id,
                              queuedId: item.id,
                            })
                          }
                        >
                          <IconBolt size={14} />
                        </ActionIcon>
                      </span>
                    </Tooltip>
                  )}
                  {canEdit && (
                    <Tooltip label="Edit this prompt" withArrow openDelay={300}>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        onClick={() => setEditing({ id: item.id, snapshot: item })}
                      >
                        <IconPencil size={14} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="sm"
                    onClick={() =>
                      send({ type: 'cancelQueued', sessionId: session.id, queuedId: item.id })
                    }
                  >
                    <IconX size={14} />
                  </ActionIcon>
                </Group>
              </Group>
            )}
          </Paper>
        );
      })}
    </Stack>
  );
}
