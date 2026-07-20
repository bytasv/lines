import { useState } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Code,
  Collapse,
  Group,
  Paper,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconChevronDown,
  IconChevronRight,
  IconTool,
  IconZoomScan,
} from '@tabler/icons-react';
import type { ToolBlock } from '../lib/transcript';
import { computeDiff, diffStats, isEditTool } from '../lib/transcript';
import { MonacoDiffModal } from './MonacoDiffModal';

function summarizeInput(tool: ToolBlock): string {
  const input = tool.input;
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return String(input.pattern);
  if (typeof input.url === 'string') return String(input.url);
  if (typeof input.description === 'string') return String(input.description);
  const json = JSON.stringify(input);
  return json.length > 120 ? json.slice(0, 120) + '…' : json;
}

export function ToolCallCard({ tool }: { tool: ToolBlock }) {
  const [expanded, setExpanded] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);

  const editTool = isEditTool(tool.name);
  const diff = editTool ? computeDiff(tool) : null;
  const stats = diff ? diffStats(diff.before, diff.after) : null;
  const pending = tool.result === undefined && !editTool;

  return (
    <Paper withBorder radius="md" px="sm" py={6} bg="var(--mantine-color-default)">
      <Group gap="xs" wrap="nowrap" justify="space-between">
        <Group
          gap="xs"
          wrap="nowrap"
          style={{ cursor: 'pointer', minWidth: 0, flex: 1 }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          <IconTool size={13} opacity={0.6} />
          <Badge variant="light" color={tool.isError ? 'red' : editTool ? 'teal' : 'blue'} tt="none">
            {tool.name}
          </Badge>
          <Text size="xs" c="dimmed" ff="monospace" truncate style={{ flex: 1 }}>
            {summarizeInput(tool)}
          </Text>
          {pending && (
            <Badge variant="dot" color="yellow">
              running
            </Badge>
          )}
        </Group>
        {diff && (
          <Group gap={4} wrap="nowrap">
            {stats && (
              <Text size="xs" ff="monospace">
                <Text span c="teal">
                  +{stats.added}
                </Text>{' '}
                <Text span c="red">
                  −{stats.removed}
                </Text>
              </Text>
            )}
            <Tooltip label="Open diff in Monaco">
              <ActionIcon size="sm" variant="light" onClick={() => setDiffOpen(true)}>
                <IconZoomScan size={14} />
              </ActionIcon>
            </Tooltip>
          </Group>
        )}
      </Group>
      <Collapse expanded={expanded}>
        <Box mt={6}>
          <Text size="xs" c="dimmed" fw={600}>
            Input
          </Text>
          <Code block style={{ fontSize: 11, maxHeight: 200, overflow: 'auto' }}>
            {JSON.stringify(tool.input, null, 2)}
          </Code>
          {tool.result !== undefined && (
            <>
              <Text size="xs" c="dimmed" fw={600} mt={6}>
                Result {tool.isError ? '(error)' : ''}
              </Text>
              <Code
                block
                color={tool.isError ? 'red' : undefined}
                style={{ fontSize: 11, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}
              >
                {tool.result.length > 6000 ? tool.result.slice(0, 6000) + '\n…(truncated)' : tool.result}
              </Code>
            </>
          )}
        </Box>
      </Collapse>
      {diff && (
        <MonacoDiffModal
          opened={diffOpen}
          onClose={() => setDiffOpen(false)}
          filePath={diff.filePath}
          before={diff.before}
          after={diff.after}
        />
      )}
    </Paper>
  );
}
