import { memo, useState, type ReactNode } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Code,
  Collapse,
  Group,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconChevronDown,
  IconChevronRight,
  IconPointFilled,
  IconZoomScan,
} from '@tabler/icons-react';
import type { ToolBlock, ToolGroupItem, TranscriptItem } from '../lib/transcript';
import { groupSummary, isEditTool, isQuestionTool, toolDiff } from '../lib/transcript';
import { isAgentTool } from '../lib/agents';
import { BODY_CAP, toolFields, toolSummary, type ToolField } from '../lib/toolFields';
import { MonacoDiffModal } from './MonacoDiffModal';
import { QuestionReview } from './QuestionPrompt';
import { TaskBody, TaskHeader } from './TaskCall';

/** The tool calls a subagent made, for the card's activity subtitle. */
function nestedTools(items: TranscriptItem[]): ToolBlock[] {
  return items.filter((i): i is ToolGroupItem => i.kind === 'tool-group').flatMap((g) => g.tools);
}

/** Inline field values above this, or spanning lines, need their own code block. */
const INLINE_FIELD_CAP = 120;

function fieldIsBlock(field: ToolField): boolean {
  if (field.kind === 'code' || field.kind === 'json') return true;
  return field.value.includes('\n') || field.value.length > INLINE_FIELD_CAP;
}

/**
 * A tool call's input as a field list instead of a JSON dump: the field that names
 * the call reads prominently, the rest as dimmed `label: value` lines. The raw JSON
 * stays one toggle away — {@link toolFields} classifies defensively, and MCP tools
 * carry input shapes it can't know about.
 */
function ToolFields({ tool }: { tool: ToolBlock }) {
  // The primary field is already the collapsed row's one-liner: repeating a Read's
  // path or a short Bash command inside the body is pure duplication. It survives
  // only when it needs a block (multi-line or long), where the row can show a
  // truncated first line at best.
  const fields = toolFields(tool).filter((f) => f.kind !== 'primary' || fieldIsBlock(f));
  if (fields.length === 0) return null;
  return (
    <Stack gap={2} style={{ minWidth: 0 }}>
      {fields.map((field) => {
        const block = fieldIsBlock(field);
        if (field.kind === 'primary') {
          return block ? (
            <Code
              key={field.key}
              block
              style={{ fontSize: 11, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap' }}
            >
              {field.value}
            </Code>
          ) : (
            <Text key={field.key} size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>
              {field.value}
            </Text>
          );
        }
        return (
          <Box key={field.key}>
            <Text size="xs" ff={!block && field.kind === 'path' ? 'monospace' : undefined}>
              <Text span size="xs" c="dimmed" ff="var(--mantine-font-family)">
                {field.label}
                {block ? '' : ': '}
              </Text>
              {!block && field.value}
            </Text>
            {block && (
              <Code
                block
                style={{ fontSize: 11, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap' }}
              >
                {field.value}
              </Code>
            )}
          </Box>
        );
      })}
    </Stack>
  );
}

/**
 * The escape hatch behind the structured field list. Serialized only while open —
 * the same laziness the collapsed body already relies on, and the reason this is
 * strictly cheaper than the unconditional JSON dump it replaced.
 */
function RawInput({ input }: { input: Record<string, unknown> }) {
  const [shown, setShown] = useState(false);
  const json = shown ? JSON.stringify(input, null, 2) : '';
  return (
    <>
      <Button variant="subtle" size="compact-xs" onClick={() => setShown((v) => !v)}>
        {shown ? 'Hide raw input' : 'Show raw input'}
      </Button>
      {shown && (
        <Code block style={{ fontSize: 11, maxHeight: 200, overflow: 'auto' }}>
          {json.length > BODY_CAP ? json.slice(0, BODY_CAP) + '\n…(truncated)' : json}
        </Code>
      )}
    </>
  );
}

// Sticky per-card expansion, keyed by tool_use id. Module scope so it survives
// the card unmounting — which now happens whenever its group collapses.
const stickyExpanded = new Map<string, boolean>();

/**
 * Memoized on the tool block: a card whose block was reused by reconcileItems has
 * nothing new to render, and its diff (asked for here, in the group header and in
 * the folded turn's totals) stays cached alongside it.
 */
export const ToolCallCard = memo(function ToolCallCard({
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
  // A backgrounded call is handed its result the instant it launches ("Async agent
  // launched successfully"), so the task's own state is what says whether it is done.
  const pending = (tool.result === undefined || tool.background?.status === 'running') && !editTool;
  // An Agent/Task call reads as a subagent *run*: its own header, its own container,
  // and the subagent's tool tally instead of nothing.
  const isAgent = isAgentTool(tool.name);
  const isQuestion = isQuestionTool(tool.name);
  const children = tool.children ?? [];
  const nested = children.length > 0 ? nestedTools(children) : [];
  // A successful edit has nothing behind the chevron the diff button doesn't show
  // better — the body would be the file content it already renders plus a
  // "File updated successfully" line. Errors stay expandable: that text is the point.
  const expandable = !(editTool && diff && !tool.isError);

  // An answered question is the record of a decision, not a step — it renders as
  // the review itself: always open, no row, no chevron. The row would only repeat
  // what QuestionReview shows anyway (each question's header badge and text).
  // Pending keeps the normal card — the live prompt below it is the interactive
  // copy — and so do errors, whose result text is the point. A malformed input
  // (no questions to review) also stays a card rather than vanishing.
  if (
    isQuestion &&
    !pending &&
    !tool.isError &&
    Array.isArray(tool.input.questions) &&
    tool.input.questions.length > 0
  ) {
    return <QuestionReview input={tool.input} result={tool.result} />;
  }

  return (
    <Box className={isAgent ? 'tx-task' : undefined}>
      <Group
        className={expandable ? 'tx-row' : 'tx-row tx-static'}
        gap="xs"
        wrap="nowrap"
        justify="space-between"
        onClick={expandable ? toggle : undefined}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        onKeyDown={
          expandable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle();
                }
              }
            : undefined
        }
      >
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
          {/* A row with nothing to expand marks the chevron's slot with a dot rather
              than leaving it blank: every row's badge stays in the same column, and
              the gap reads as a deliberate end rather than a missing control. */}
          {expandable ? (
            expanded ? (
              <IconChevronDown size={13} />
            ) : (
              <IconChevronRight size={13} />
            )
          ) : (
            <Center w={13} h={13} c="dimmed" style={{ flexShrink: 0 }}>
              <IconPointFilled size={6} opacity={0.35} />
            </Center>
          )}
          {isAgent ? (
            <TaskHeader tool={tool} nested={nested} />
          ) : (
            <>
              <Badge
                variant="light"
                color={tool.isError ? 'red' : editTool ? 'teal' : 'blue'}
                tt="none"
              >
                {tool.name}
              </Badge>
              <Text size="xs" c="dimmed" ff="monospace" truncate style={{ flex: 1 }}>
                {toolSummary(tool)}
              </Text>
              {nested.length > 0 && (
                <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                  {groupSummary(nested)}
                </Text>
              )}
            </>
          )}
          {pending && (
            <Badge variant="dot" color="yellow">
              running
            </Badge>
          )}
          {/* Terminal non-happy states only: a `completed` background task is already
              told by the card's result and children. */}
          {tool.background && !['running', 'completed'].includes(tool.background.status) && (
            <Badge variant="dot" color={tool.background.status === 'failed' ? 'red' : 'gray'}>
              {tool.background.status}
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
            {/* A background agent can sit running for minutes before its first
                nested message lands — say so rather than showing a blank body. */}
            {isAgent && children.length === 0 && pending && (
              <Text size="xs" c="dimmed" fs="italic">
                Waiting for the agent's first message…
              </Text>
            )}
            {isAgent ? (
              <TaskBody tool={tool} />
            ) : isQuestion ? (
              <QuestionReview input={tool.input} result={tool.result} />
            ) : (
              <ToolFields tool={tool} />
            )}
            {/* An answered question is fully told by the option cards above — the raw
                questions array and the "your questions have been answered" result add
                nothing a reader wants. */}
            {!isQuestion && <RawInput input={tool.input} />}
            {tool.result !== undefined && (!isQuestion || tool.isError) && (
              <>
                <Text size="xs" c="dimmed" fw={600} mt={6}>
                  {isAgent ? 'Agent report' : 'Result'} {tool.isError ? '(error)' : ''}
                </Text>
                <Code
                  block
                  color={tool.isError ? 'red' : undefined}
                  style={{ fontSize: 11, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}
                >
                  {tool.result.length > BODY_CAP
                    ? tool.result.slice(0, BODY_CAP) + '\n…(truncated)'
                    : tool.result}
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
});
