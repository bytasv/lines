import { ActionIcon, Avatar, Badge, Group, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import type { SessionMeta } from '@lines/shared';
import { mentionKindMeta } from '../lib/mentions';
import { useIdentityResolver } from '../lib/identity';
import { useStore } from '../store';
import { send } from '../ws';

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
  item: NonNullable<SessionMeta['queued']>[number];
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

/** Prompts held server-side while the session is busy; sent FIFO after each turn. */
export function QueuedMessages({ session }: { session: SessionMeta }) {
  const queued = session.queued;
  const identify = useIdentityResolver();
  // Our own prompts need the host's approval — so the queue is waiting on them,
  // not on us.
  const needsApproval = useStore((s) => s.access?.caps.promptNeedsApproval === true);
  const ownerName = useStore(
    (s) => s.access?.ownerProfile?.name ?? s.access?.ownerProfile?.email ?? 'the owner',
  );
  // Distinct names of everyone other than you with a prompt in this queue.
  const othersWaiting = [
    ...new Set(
      (queued ?? [])
        .map((item) => identify(item.actor?.userId, item.actor))
        .filter((who) => !who.self)
        .map((who) => who.name),
    ),
  ];
  if (!queued?.length) return null;

  return (
    <Stack gap={6} maw={920} mx="auto" w="100%" px="md" pb={4}>
      <Group gap="xs">
        <Text size="xs" c="dimmed" fw={600}>
          Queued · {queued.length}
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
      {queued.map((item) => (
        <Paper
          key={item.id}
          p="xs"
          radius="md"
          style={{ border: '1px dashed var(--mantine-color-default-border)' }}
        >
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
              </Group>
              {!!item.mentions?.length && (
                <Group gap={4}>
                  {item.mentions.map((m) => {
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
              )}
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
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={() => send({ type: 'cancelQueued', sessionId: session.id, queuedId: item.id })}
            >
              <IconX size={14} />
            </ActionIcon>
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}
