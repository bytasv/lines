import { ActionIcon, Badge, Group, Paper, Stack, Text } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import type { SessionMeta } from '@lines/shared';
import { mentionKindMeta } from '../lib/mentions';
import { send } from '../ws';

/** Prompts held server-side while the session is busy; sent FIFO after each turn. */
export function QueuedMessages({ session }: { session: SessionMeta }) {
  const queued = session.queued;
  if (!queued?.length) return null;

  return (
    <Stack gap={6} maw={920} mx="auto" w="100%" px="md" pb={4}>
      <Group gap="xs">
        <Text size="xs" c="dimmed" fw={600}>
          Queued · {queued.length}
        </Text>
        {session.queuePaused && (
          <Badge size="xs" color="yellow" variant="light">
            paused — sending a message resumes
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
              <Text size="sm" c="dimmed" lineClamp={2}>
                {item.text}
              </Text>
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
