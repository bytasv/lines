import { useState } from 'react';
import { Badge, Box, Button, Code, Group, Text, Tooltip } from '@mantine/core';
import { agentMeta, parseTaskInput, taskFlags } from '../lib/agents';
import { BODY_CAP } from '../lib/toolFields';
import { groupSummary, type ToolBlock } from '../lib/transcript';

/**
 * The header of a `Task` row: the agent's identity, then what it was asked to do.
 * A Task is a *run*, not a tool invocation — the tool name "Task" carries no
 * information, so the badge names the agent and the description is the primary
 * text (not dimmed, not monospace: it is prose).
 *
 * Deliberately dumb — the chevron, the `running` badge and the expanded body all
 * stay with {@link ToolCallCard}, so every row type keeps one chevron column.
 */
export function TaskHeader({ tool, nested }: { tool: ToolBlock; nested: ToolBlock[] }) {
  const call = parseTaskInput(tool.input);
  const meta = agentMeta(call.subagentType);
  const flags = taskFlags(call);
  const hasMeta = flags.length > 0 || call.model !== undefined || call.name !== undefined;

  return (
    <>
      <Badge
        variant="light"
        color={tool.isError ? 'red' : meta.color}
        tt="none"
        leftSection={<meta.icon size={11} />}
      >
        {meta.label}
      </Badge>
      {call.description && (
        <Text size="xs" fw={500} truncate style={{ flex: 1, minWidth: 0 }}>
          {call.description}
        </Text>
      )}
      {hasMeta && (
        <Group gap={4} wrap="nowrap" c="dimmed" style={{ flexShrink: 0 }}>
          {flags.map((flag) => (
            <Tooltip key={flag.key} label={flag.label} withArrow>
              {/* Span wrapper: the tooltip needs a stable hover target, and an inline
                  SVG's baseline gap makes the icon jitter against the badge. */}
              <Box component="span" style={{ display: 'flex' }}>
                <flag.icon
                  size={13}
                  color={flag.color ? `var(--mantine-color-${flag.color}-6)` : undefined}
                />
              </Box>
            </Tooltip>
          ))}
          {call.model && (
            <Text size="xs" c="dimmed">
              {call.model}
            </Text>
          )}
          {call.name && (
            <Text size="xs" c="dimmed">
              @{call.name}
            </Text>
          )}
        </Group>
      )}
      {nested.length > 0 && (
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
          {groupSummary(nested)}
        </Text>
      )}
    </>
  );
}

function promptToggleLabel(length: number): string {
  return length >= 1000
    ? `Show prompt (${Math.round(length / 1000).toLocaleString()}k chars)`
    : `Show prompt (${length} chars)`;
}

/**
 * The Task-specific part of an expanded card: the prompt, on demand. Always behind
 * the toggle even when short — a uniform affordance beats a length threshold.
 *
 * Rendered as `Code`, never `Markdown`: prompts are full of literal markdown and XML
 * that must not be reflowed, and ReactMarkdown over a multi-kB prompt is the
 * first-paint hazard the transcript's other caps exist to dodge.
 */
export function TaskBody({ tool }: { tool: ToolBlock }) {
  const [shown, setShown] = useState(false);
  const { prompt } = parseTaskInput(tool.input);
  if (!prompt) return null;

  return (
    <>
      <Button variant="subtle" size="compact-xs" onClick={() => setShown((v) => !v)}>
        {shown ? 'Hide prompt' : promptToggleLabel(prompt.length)}
      </Button>
      {shown && (
        <Code
          block
          style={{ fontSize: 11, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap' }}
        >
          {prompt.length > BODY_CAP ? prompt.slice(0, BODY_CAP) + '\n…(truncated)' : prompt}
        </Code>
      )}
    </>
  );
}
