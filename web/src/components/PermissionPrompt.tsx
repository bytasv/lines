import { useState } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconArrowsMaximize,
  IconFilePencil,
  IconMap,
  IconShieldQuestion,
  IconTerminal2,
  IconWorld,
  IconZoomScan,
} from '@tabler/icons-react';
import type { PermissionRequestData } from '@claude-ui/shared';
import { send } from '../ws';
import { QuestionPrompt } from './QuestionPrompt';
import { Markdown } from './Markdown';
import { MonacoDiffModal } from './MonacoDiffModal';
import { computeDiff, isEditTool, type ToolBlock } from '../lib/transcript';

type Resolution = 'allow' | 'deny' | 'expired';

const RESOLUTION_BADGE: Record<Resolution, { color: string; label: string }> = {
  allow: { color: 'teal', label: 'allowed' },
  deny: { color: 'red', label: 'denied' },
  expired: { color: 'gray', label: 'expired' },
};

function respond(
  sessionId: string,
  requestId: string,
  allow: boolean,
  denyMessage?: string,
) {
  send({ type: 'permissionResponse', sessionId, requestId, allow, denyMessage });
}

/** Per-tool presentation: title, icon, body, and button labels. */
function toolPresentation(data: PermissionRequestData): {
  icon: React.ReactNode;
  title: string;
  allowLabel: string;
  denyLabel: string;
  denyMessage?: string;
  body: React.ReactNode;
} {
  const input = data.input;

  switch (data.toolName) {
    case 'Bash':
      return {
        icon: <IconTerminal2 size={16} color="var(--mantine-color-yellow-6)" />,
        title: 'Claude wants to run a command',
        allowLabel: 'Run command',
        denyLabel: 'Deny',
        body: (
          <>
            <Code block style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {String(input.command ?? '')}
            </Code>
            {typeof input.description === 'string' && input.description && (
              <Text size="xs" c="dimmed" mt={4}>
                {input.description}
              </Text>
            )}
          </>
        ),
      };

    case 'WebFetch':
    case 'WebSearch':
      return {
        icon: <IconWorld size={16} color="var(--mantine-color-blue-5)" />,
        title: data.toolName === 'WebFetch' ? 'Claude wants to fetch a URL' : 'Claude wants to search the web',
        allowLabel: 'Allow',
        denyLabel: 'Deny',
        body: (
          <Text size="sm" ff="monospace" style={{ wordBreak: 'break-all' }}>
            {String(input.url ?? input.query ?? '')}
          </Text>
        ),
      };

    default: {
      if (isEditTool(data.toolName)) {
        return {
          icon: <IconFilePencil size={16} color="var(--mantine-color-teal-5)" />,
          title:
            data.toolName === 'Write'
              ? 'Claude wants to write a file'
              : 'Claude wants to edit a file',
          allowLabel: data.toolName === 'Write' ? 'Write file' : 'Apply edit',
          denyLabel: 'Deny',
          body: <EditPreview data={data} />,
        };
      }
      const json = JSON.stringify(input, null, 2);
      return {
        icon: <IconShieldQuestion size={16} color="var(--mantine-color-yellow-6)" />,
        title: `Claude wants to use ${data.toolName || 'a tool'}`,
        allowLabel: 'Allow',
        denyLabel: 'Deny',
        body:
          json !== '{}' ? (
            <Code block style={{ fontSize: 11, maxHeight: 200, overflow: 'auto' }}>
              {json.length > 2000 ? json.slice(0, 2000) + '…' : json}
            </Code>
          ) : null,
      };
    }
  }
}

/** File-path line + fragment diff with Monaco zoom for Edit/Write/MultiEdit requests. */
function EditPreview({ data }: { data: PermissionRequestData }) {
  const [diffOpen, setDiffOpen] = useState(false);
  // No pre-edit snapshot exists yet at permission time; computeDiff falls back
  // to content / old-vs-new fragments, which is exactly what to review here.
  const tool: ToolBlock = { type: 'tool', id: data.requestId, name: data.toolName, input: data.input };
  const diff = computeDiff(tool);
  const filePath = String(data.input.file_path ?? data.input.notebook_path ?? '');

  return (
    <>
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Text size="sm" ff="monospace" truncate>
          {filePath}
        </Text>
        {diff && (
          <Tooltip label="Review in Monaco">
            <ActionIcon size="sm" variant="light" onClick={() => setDiffOpen(true)}>
              <IconZoomScan size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
      {diff && (
        <ScrollArea.Autosize mah={220} type="auto" mt={4}>
          <Code block style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>
            {diff.after.length > 3000 ? diff.after.slice(0, 3000) + '…' : diff.after}
          </Code>
        </ScrollArea.Autosize>
      )}
      {diff && (
        <MonacoDiffModal
          opened={diffOpen}
          onClose={() => setDiffOpen(false)}
          filePath={diff.filePath}
          before={diff.before}
          after={diff.after}
        />
      )}
    </>
  );
}

const KEEP_PLANNING_MESSAGE =
  'The user is not ready to proceed — stay in plan mode and refine the plan based on their next message.';

/** Plan review with a distraction-free full-screen focus mode (auto-opens while pending). */
function PlanApproval({
  sessionId,
  data,
  resolution,
}: {
  sessionId: string;
  data: PermissionRequestData;
  resolution?: Resolution;
}) {
  const [focus, setFocus] = useState(true);
  const plan = String(data.input.plan ?? '');

  const approve = () => respond(sessionId, data.requestId, true);
  const keepPlanning = () => respond(sessionId, data.requestId, false, KEEP_PLANNING_MESSAGE);

  const actions = (
    <Group gap="xs">
      <Button size="xs" onClick={approve}>
        Approve plan &amp; start
      </Button>
      <Button size="xs" variant="default" onClick={keepPlanning}>
        Keep planning
      </Button>
    </Group>
  );

  return (
    <>
      <Paper
        withBorder
        radius="md"
        p="sm"
        style={{ borderColor: resolution ? undefined : 'var(--mantine-color-sandstone-6)' }}
      >
        <Group gap="xs" justify="space-between" mb={resolution ? 0 : 8}>
          <Group gap="xs">
            <IconMap size={16} color="var(--mantine-color-sandstone-5)" />
            <Text size="sm" fw={600}>
              Claude finished planning
            </Text>
            {resolution && (
              <Badge color={RESOLUTION_BADGE[resolution].color} variant="light">
                {resolution === 'allow' ? 'plan approved' : RESOLUTION_BADGE[resolution].label}
              </Badge>
            )}
          </Group>
          <Tooltip label="Focus mode">
            <ActionIcon size="sm" variant="light" onClick={() => setFocus(true)}>
              <IconArrowsMaximize size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
        {!resolution && (
          <>
            <ScrollArea.Autosize mah={320} type="auto">
              <Paper bg="var(--mantine-color-default-hover)" radius="md" px="sm" py={4}>
                <Markdown text={plan} />
              </Paper>
            </ScrollArea.Autosize>
            <Box mt="sm">{actions}</Box>
          </>
        )}
      </Paper>

      <Modal
        opened={focus && !resolution}
        onClose={() => setFocus(false)}
        fullScreen
        padding={0}
        withCloseButton={false}
        transitionProps={{ transition: 'fade', duration: 150 }}
      >
        <Box h="100vh" style={{ display: 'flex', flexDirection: 'column' }}>
          <Group px="xl" py="md" justify="space-between">
            <Group gap="xs">
              <IconMap size={18} color="var(--mantine-color-sandstone-5)" />
              <Text fw={700}>Plan review</Text>
            </Group>
            <Button variant="subtle" color="gray" size="xs" onClick={() => setFocus(false)}>
              Exit focus (Esc)
            </Button>
          </Group>
          <ScrollArea style={{ flex: 1 }}>
            <Box maw={760} mx="auto" px="xl" pb="xl" fz="md">
              <Markdown text={plan} />
            </Box>
          </ScrollArea>
          <Group
            justify="center"
            py="md"
            style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
          >
            <Button size="sm" onClick={approve}>
              Approve plan &amp; start
            </Button>
            <Button variant="default" size="sm" onClick={keepPlanning}>
              Keep planning
            </Button>
          </Group>
        </Box>
      </Modal>
    </>
  );
}

export function PermissionPrompt({
  sessionId,
  data,
  resolution,
}: {
  sessionId: string;
  data: PermissionRequestData;
  resolution?: Resolution;
}) {
  // Clarifying questions get a dedicated interactive card instead of raw JSON.
  if (data.toolName === 'AskUserQuestion') {
    return <QuestionPrompt sessionId={sessionId} data={data} resolution={resolution} />;
  }
  // Plans get a full-screen distraction-free review mode.
  if (data.toolName === 'ExitPlanMode') {
    return <PlanApproval sessionId={sessionId} data={data} resolution={resolution} />;
  }

  const p = toolPresentation(data);

  return (
    <Paper
      withBorder
      radius="md"
      p="sm"
      style={{ borderColor: resolution ? undefined : 'var(--mantine-color-yellow-6)' }}
    >
      <Group gap="xs" mb={resolution ? 0 : 8}>
        {p.icon}
        <Text size="sm" fw={600}>
          {p.title}
        </Text>
        {resolution && (
          <Badge color={RESOLUTION_BADGE[resolution].color} variant="light">
            {RESOLUTION_BADGE[resolution].label}
          </Badge>
        )}
      </Group>
      {resolution === 'expired' && (
        <Text size="xs" c="dimmed" mt={4}>
          This request is no longer active (the turn ended or the server restarted). Re-send your
          prompt to continue.
        </Text>
      )}
      {!resolution && (
        <>
          {data.guardReason && (
            <Text size="xs" c="orange" mb={6}>
              ⚠ Flagged by auto-mode guard: {data.guardReason}
            </Text>
          )}
          {p.body}
          <Group gap="xs" mt="sm">
            <Button
              size="xs"
              onClick={() => respond(sessionId, data.requestId, true)}
            >
              {p.allowLabel}
            </Button>
            {data.guardReason && (
              <Tooltip label="Allow now and add this pattern to the auto-mode allowlist">
                <Button
                  size="xs"
                  variant="light"
                  onClick={() =>
                    send({
                      type: 'permissionResponse',
                      sessionId,
                      requestId: data.requestId,
                      allow: true,
                      alwaysAllow: true,
                    })
                  }
                >
                  Always allow
                </Button>
              </Tooltip>
            )}
            <Button
              size="xs"
              color="red"
              variant="light"
              onClick={() => respond(sessionId, data.requestId, false, p.denyMessage)}
            >
              {p.denyLabel}
            </Button>
          </Group>
        </>
      )}
    </Paper>
  );
}
