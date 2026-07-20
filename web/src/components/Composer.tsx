import { useState } from 'react';
import {
  ActionIcon,
  Group,
  Paper,
  SegmentedControl,
  Select,
  Switch,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { IconPlayerStop, IconSend } from '@tabler/icons-react';
import type { CavemanLevel, PermissionMode, SessionMeta } from '@claude-ui/shared';
import { useStore } from '../store';
import { send } from '../ws';

const MODE_LABELS: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Agent' },
  { value: 'auto', label: 'Auto' },
  { value: 'acceptEdits', label: 'Edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' },
];

export function Composer({ session }: { session: SessionMeta }) {
  const models = useStore((s) => s.models);
  const [text, setText] = useState('');
  const running = session.status === 'running' || session.status === 'waiting-permission';

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    send({ type: 'prompt', sessionId: session.id, text: trimmed });
    setText('');
  };

  return (
    <Paper withBorder radius="lg" p="xs" m="md" mt={4} maw={920} mx="auto" w="100%">
      <Textarea
        placeholder={
          session.workflow && !session.workflow.started
            ? 'Describe the task — this kicks off the workflow…'
            : 'Message Claude… (⌘↵ to send)'
        }
        autosize
        minRows={2}
        maxRows={10}
        variant="unstyled"
        px={6}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      <Group justify="space-between" px={4} pt={4}>
        <Group gap="xs">
          <SegmentedControl
            size="xs"
            data={MODE_LABELS}
            value={session.permissionMode}
            onChange={(v) =>
              send({ type: 'setPermissionMode', sessionId: session.id, mode: v as PermissionMode })
            }
          />
          <Select
            w={130}
            data={models.map((m) => ({ value: m.id, label: m.label }))}
            value={session.model}
            onChange={(v) => v && send({ type: 'setModel', sessionId: session.id, model: v })}
            allowDeselect={false}
          />
          <Tooltip label="Caveman mode — compressed replies, fewer tokens">
            <Switch
              size="xs"
              label="🦴"
              checked={session.caveman.enabled}
              onChange={(e) =>
                send({
                  type: 'setCaveman',
                  sessionId: session.id,
                  caveman: { ...session.caveman, enabled: e.currentTarget.checked },
                })
              }
            />
          </Tooltip>
          {session.caveman.enabled && (
            <Select
              w={80}
              size="xs"
              data={['lite', 'full', 'ultra']}
              value={session.caveman.level}
              onChange={(v) =>
                v &&
                send({
                  type: 'setCaveman',
                  sessionId: session.id,
                  caveman: { ...session.caveman, level: v as CavemanLevel },
                })
              }
              allowDeselect={false}
            />
          )}
        </Group>
        <Group gap="xs">
          {session.totalCostUsd != null && (
            <Text size="xs" c="dimmed">
              ${session.totalCostUsd.toFixed(3)}
            </Text>
          )}
          {running ? (
            <Tooltip label="Interrupt">
              <ActionIcon color="red" variant="light" size="lg" onClick={() => send({ type: 'interrupt', sessionId: session.id })}>
                <IconPlayerStop size={16} />
              </ActionIcon>
            </Tooltip>
          ) : (
            <ActionIcon variant="filled" size="lg" onClick={submit} disabled={!text.trim()}>
              <IconSend size={16} />
            </ActionIcon>
          )}
        </Group>
      </Group>
    </Paper>
  );
}
