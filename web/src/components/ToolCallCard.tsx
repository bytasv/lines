import { useState, type ReactNode } from 'react';
import { ActionIcon, Badge, Box, Code, Collapse, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconZoomScan } from '@tabler/icons-react';
import type { ToolBlock, ToolGroupItem, TranscriptItem } from '../lib/transcript';
import { groupSummary, isEditTool, toolDiff } from '../lib/transcript';
import { MonacoDiffModal } from './MonacoDiffModal';

function summarizeInput(tool: ToolBlock): string {
  const input = tool.input;
  // A Task call is named by the agent it spawned, not just its description.
  if (tool.name === 'Task') {
    return `${String(input.subagent_type ?? 'agent')}: ${String(input.description ?? '')}`.trim();
  }
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return String(input.pattern);
  if (typeof input.url === 'string') return String(input.url);
  if (typeof input.description === 'string') return String(input.description);
  const json = JSON.stringify(input);
  return json.length > 120 ? json.slice(0, 120) + '…' : json;
}

/** The tool calls a subagent made, for the card's activity subtitle. */
function nestedTools(items: TranscriptItem[]): ToolBlock[] {
  return items.filter((i): i is ToolGroupItem => i.kind === 'tool-group').flatMap((g) => g.tools);
}

// Sticky per-card expansion, keyed by tool_use id. Module scope so it survives
// the card unmounting — which now happens whenever its group collapses.
const stickyExpanded = new Map<string, boolean>();

export function ToolCallCard({
  tool,
  renderNested,
}: {
  tool: ToolBlock;
  /** Renders a subagent's items inside this card. Passed down instead of importing
   *  Transcript's `Item` — that module already imports this one. */
  renderNested?: (items: TranscriptItem[]) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(() => stickyExpanded.get(tool.id) ?? false);
  const [diffOpen, setDiffOpen] = useState(false);

  const toggle = () =>
    setExpanded((v) => {
      stickyExpanded.set(tool.id, !v);
      return !v;
    });

  const editTool = isEditTool(tool.name);
  // Memoized per tool block — the same diff is also asked for by the group
  // header and the folded turn's totals.
  const entry = toolDiff(tool);
  const diff = entry?.diff ?? null;
  const stats = entry?.stats ?? null;
  const pending = tool.result === undefined && !editTool;
  // A Task call with a subagent transcript underneath it: violet badge, and the
  // subagent's own tool tally instead of nothing.
  const children = tool.children ?? [];
  const nested = children.length > 0 ? nestedTools(children) : [];

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
          <Badge
            variant="light"
            color={tool.isError ? 'red' : children.length > 0 ? 'violet' : editTool ? 'teal' : 'blue'}
            tt="none"
          >
            {tool.name}
          </Badge>
          <Text size="xs" c="dimmed" ff="monospace" truncate style={{ flex: 1 }}>
            {summarizeInput(tool)}
          </Text>
          {nested.length > 0 && (
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
              {groupSummary(nested)}
            </Text>
          )}
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
              <ActionIcon
                size="sm"
                variant="light"
                // Sits inside the row's click target — don't toggle the row too.
                onClick={(e) => {
                  e.stopPropagation();
                  setDiffOpen(true);
                }}
              >
                <IconZoomScan size={14} />
              </ActionIcon>
            </Tooltip>
          </Group>
        )}
      </Group>
      {/* Body is rendered only while open: on a long transcript most cards are
          collapsed, and serializing every tool input and result just to hide it
          with CSS is most of the transcript's first-paint cost. */}
      <Collapse expanded={expanded}>
        {expanded && (
          <Box mt={4}>
            {/* The subagent's own transcript, above the raw call — opening a Task
                card should show what the agent did, not a JSON dump. */}
            {children.length > 0 && renderNested && (
              <Stack gap={6} mb={6} style={{ minWidth: 0 }}>
                {renderNested(children)}
              </Stack>
            )}
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
        )}
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
    </Box>
  );
}
