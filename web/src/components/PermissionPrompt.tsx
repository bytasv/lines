import { useEffect, useId, useRef, useState } from 'react';
import {
  ActionIcon,
  Avatar,
  Badge,
  Box,
  Button,
  Center,
  Code,
  Collapse,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import {
  IconArrowsMaximize,
  IconChevronDown,
  IconChevronRight,
  IconFilePencil,
  IconMap,
  IconMessagePlus,
  IconPencil,
  IconPointFilled,
  IconShieldQuestion,
  IconTerminal2,
  IconTrash,
  IconWorld,
  IconZoomScan,
} from '@tabler/icons-react';
import type { PermissionRequestData, PermissionResolutionSource, PlanComment } from '@lines/shared';
import { KEEP_PLANNING_MESSAGE, normalizePlanComments } from '@lines/shared';
import { send } from '../ws';
import { readPlanComments, useStore, writePlanComments } from '../store';
import { useCan } from '../lib/can';
import { useIdentityResolver } from '../lib/identity';
import { QuestionPrompt } from './QuestionPrompt';
import { Markdown } from './Markdown';
import { MonacoDiffModal } from './MonacoDiffModal';
import { computeDiff, isEditTool, type ToolBlock } from '../lib/transcript';
import { useFileContent } from '../lib/files';

type Resolution = 'allow' | 'deny' | 'expired';

const RESOLUTION_BADGE: Record<Resolution, { color: string; label: string }> = {
  allow: { color: 'teal', label: 'allowed' },
  deny: { color: 'red', label: 'denied' },
  expired: { color: 'gray', label: 'expired' },
};

/**
 * How a resolution came about, when it was not a plain click on this card. The
 * label itself stays as it was — this only makes "who decided?" answerable from
 * the transcript. 'user' has no note: that is what the badge already implies.
 */
const SOURCE_NOTE: Partial<Record<PermissionResolutionSource, string>> = {
  'plan-reply': 'resolved by your reply in the composer',
  auto: 'approved automatically by the auto-mode guard',
  recovery: 'resolved by recovery after an interrupted turn',
  'workflow-advance': 'you approved this; the workflow advanced instead of implementing here',
  'interrupt-expire': 'closed when the interrupted session was resumed',
  stop: 'closed when the turn was stopped',
  cancel: 'cancelled by Claude Code',
};

/** The resolution badge, with a provenance tooltip when a human did not click it. */
function ResolutionBadge({
  data,
  color,
  children,
}: {
  data: PermissionRequestData;
  color: string;
  children: React.ReactNode;
}) {
  const note = data.resolvedBy ? SOURCE_NOTE[data.resolvedBy] : undefined;
  const identify = useIdentityResolver();
  // Who clicked, when it was not you. "Approved by Antanas" is the thing you most
  // want to know after the fact — a permission ran a command on this machine.
  const actor = data.resolvedActor;
  const who = actor ? identify(actor.userId, actor) : null;
  const byWhom = who && !who.self ? who.name : null;
  const badge = (
    <Badge
      color={color}
      variant="light"
      leftSection={
        who && byWhom ? (
          <Avatar
            src={who.imageUrl ?? undefined}
            size={12}
            radius="xl"
            color={who.color}
            variant="filled"
          >
            <Text size="7px" fw={700}>
              {who.initials}
            </Text>
          </Avatar>
        ) : undefined
      }
    >
      {children}
      {byWhom ? ` · ${byWhom}` : ''}
    </Badge>
  );
  const label = [note, byWhom ? `Answered by ${byWhom}` : null].filter(Boolean).join('\n');
  return label ? (
    <Tooltip label={label} multiline styles={{ tooltip: { whiteSpace: 'pre-line' } }}>
      {badge}
    </Tooltip>
  ) : (
    badge
  );
}

function respond(
  sessionId: string,
  requestId: string,
  allow: boolean,
  denyMessage?: string,
  /** ExitPlanMode only; the server re-validates and owns the deny wording. */
  planComments?: PlanComment[],
) {
  send({ type: 'permissionResponse', sessionId, requestId, allow, denyMessage, planComments });
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
      const workflowEdit = workflowToolPresentation(data.toolName, input);
      if (workflowEdit) return workflowEdit;
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

/** Lines' own workflow-editing MCP tools, as the model sees them. */
const WORKFLOW_TOOL_PREFIX = 'mcp__lines__';

const WORKFLOW_TOOL_TITLES: Record<string, { title: string; allowLabel: string }> = {
  create_workflow: { title: 'Claude wants to create a workflow', allowLabel: 'Create workflow' },
  update_workflow: { title: 'Claude wants to change a workflow', allowLabel: 'Save workflow' },
  delete_workflow: { title: 'Claude wants to delete a workflow', allowLabel: 'Delete workflow' },
  save_step: { title: 'Claude wants to save a reusable step', allowLabel: 'Save step' },
  delete_step: { title: 'Claude wants to delete a reusable step', allowLabel: 'Delete step' },
};

/**
 * A readable summary for a workflow write instead of the default JSON dump. A
 * five-step workflow serialises to a few hundred lines of prompt template, which
 * makes the approval a rubber stamp — the point of gating these is that the user
 * can see what changes.
 */
function workflowToolPresentation(
  toolName: string,
  input: Record<string, unknown>,
): ReturnType<typeof toolPresentation> | null {
  if (!toolName.startsWith(WORKFLOW_TOOL_PREFIX)) return null;
  const labels = WORKFLOW_TOOL_TITLES[toolName.slice(WORKFLOW_TOOL_PREFIX.length)];
  if (!labels) return null; // a read tool, or one added since — fall through to the default card

  const target = String(input.workflow ?? input.name ?? input.stepId ?? '');
  const steps = Array.isArray(input.steps) ? (input.steps as Record<string, unknown>[]) : null;

  return {
    icon: <IconMap size={16} color="var(--mantine-color-violet-4)" />,
    title: labels.title,
    allowLabel: labels.allowLabel,
    denyLabel: 'Deny',
    body: (
      <>
        {target && (
          <Text size="sm" fw={500}>
            {target}
          </Text>
        )}
        {typeof input.name === 'string' && input.name && target !== input.name && (
          <Text size="xs" c="dimmed">
            Name: {input.name}
          </Text>
        )}
        {steps && (
          <Box mt={6}>
            <Text size="xs" c="dimmed" mb={2}>
              {steps.length} step{steps.length === 1 ? '' : 's'} (replaces the existing list)
            </Text>
            {steps.map((step, i) => (
              <Text key={i} size="xs" ff="monospace" truncate>
                {i + 1}. {String(step.name ?? (step.kind === 'ref' ? `pinned ${step.stepId ?? ''}` : 'untitled'))}
                {step.model ? ` — ${String(step.model)}` : ''}
                {step.permissionMode ? ` / ${String(step.permissionMode)}` : ''}
              </Text>
            ))}
          </Box>
        )}
        {typeof input.promptTemplate === 'string' && (
          <Code block mt={6} style={{ fontSize: 11, maxHeight: 160, overflow: 'auto' }}>
            {input.promptTemplate}
          </Code>
        )}
        {typeof input.published === 'boolean' && (
          <Text size="xs" c="dimmed" mt={4}>
            {input.published ? 'Shared with every user on this instance' : 'Kept private'}
          </Text>
        )}
      </>
    ),
  };
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

/**
 * The typed-reply path wraps the user's own words after the shared prefix; show
 * only those words back, so the card reads as what the user actually said.
 */
function planReplyText(data: PermissionRequestData): string | undefined {
  const msg = data.denyMessage;
  if (!msg || !msg.startsWith(KEEP_PLANNING_MESSAGE)) return undefined;
  const marker = "The user's message:\n";
  const at = msg.indexOf(marker);
  return at === -1 ? undefined : msg.slice(at + marker.length).trim() || undefined;
}

/**
 * The words that resolved a plan card — a typed composer reply, or the notes sent
 * with "Refine with comments" — attributed to whoever wrote them.
 *
 * The label was a hardcoded "You:", which is wrong the moment the session is
 * shared: a collaborator's refinement rendered as the reader's own words. The
 * actor is the one the server stamped on the resolution, resolved through the same
 * identity map {@link ResolutionBadge} uses, so a name and an avatar here agree
 * with the badge above.
 */
function PlanReply({ data, text }: { data: PermissionRequestData; text: string }) {
  const identify = useIdentityResolver();
  const actor = data.resolvedActor;
  const who = actor ? identify(actor.userId, actor) : null;
  // No actor at all is a transcript written before it was recorded; "You" is the
  // assumption those cards were rendered under, so it stays their fallback.
  const byOther = who && !who.self ? who : null;
  return (
    <Group
      gap={6}
      wrap="nowrap"
      align="flex-start"
      mt={8}
      pl="sm"
      style={{ borderLeft: '2px solid var(--mantine-color-default-border)' }}
    >
      {byOther && (
        <Avatar
          src={byOther.imageUrl ?? undefined}
          size={14}
          radius="xl"
          color={byOther.color}
          variant="filled"
          style={{ flexShrink: 0, marginTop: 1 }}
        >
          <Text size="7px" fw={700}>
            {byOther.initials}
          </Text>
        </Avatar>
      )}
      <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap', minWidth: 0 }}>
        <Text span size="xs" fw={600} c="dimmed">
          {byOther ? byOther.name : 'You'}:{' '}
        </Text>
        {text}
      </Text>
    </Group>
  );
}

/** First non-empty plan line, markdown decoration stripped — the collapsed card's headline. */
function planHeadline(plan: string): string {
  const line = plan.split('\n').find((l) => l.trim().length > 0)?.replace(/^[#*\s>-]+/, '').trim() ?? '';
  return line.length > 100 ? line.slice(0, 100) + '…' : line;
}

// ---------------------------------------------------------------------------
// Painting commented passages back onto the plan
//
// Registered with the CSS Custom Highlight API (styled in index.css), never by
// mutating the DOM: the plan body is React-rendered markdown that re-renders on
// mount and again on every live re-read of the plan file, so injected <mark>
// wrappers would be reconciled away — and mutating it from an observer would
// re-trigger the observer. A Highlight is a set of Ranges held outside the DOM,
// so a re-render costs a recomputation and nothing else.
// ---------------------------------------------------------------------------

const HIGHLIGHT_ALL = 'lines-plan-comment';
const HIGHLIGHT_ACTIVE = 'lines-plan-comment-active';

/**
 * Ranges by plan-body instance. The registry is global while the card renders the
 * plan twice — inline and in focus mode — so the two contribute to one Highlight
 * instead of overwriting each other's. Ranges in a hidden copy simply paint nothing.
 */
const planHighlights = new Map<string, { all: Range[]; active: Range[] }>();

function republishPlanHighlights() {
  // Firefox <140, Safari <17.2 and any non-browser test environment.
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
  const sets = [...planHighlights.values()];
  const all = sets.flatMap((s) => s.all);
  const active = sets.flatMap((s) => s.active);
  if (all.length) CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...all));
  else CSS.highlights.delete(HIGHLIGHT_ALL);
  if (active.length) CSS.highlights.set(HIGHLIGHT_ACTIVE, new Highlight(...active));
  else CSS.highlights.delete(HIGHLIGHT_ACTIVE);
}

/** Block-level ancestor of a text node, for deciding where a line break belongs. */
function blockOf(node: Text): Element | null {
  return node.parentElement?.closest('p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,th,figcaption') ?? null;
}

/**
 * The rendered text of `root`, whitespace-collapsed, alongside the (node, offset)
 * every surviving character came from — enough to turn a string match back into a
 * DOM Range.
 *
 * Collapsing is what makes a stored quote findable at all. `selection.toString()`
 * reports a line break between two block elements; the concatenated text nodes
 * have nothing between them. Normalizing both sides to single spaces (and
 * inserting one wherever a block boundary is crossed) puts them in the same shape.
 */
function flattenText(root: HTMLElement): { text: string; at: { node: Text; offset: number }[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = '';
  const at: { node: Text; offset: number }[] = [];
  // Leading whitespace has nothing to separate, so it starts suppressed.
  let pendingSpace = false;
  let started = false;
  let prevBlock: Element | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    // The floating comment icon and its overlay are inside the wrapper too; their
    // text is chrome, not plan.
    if (node.parentElement?.closest('[data-plan-chrome]')) continue;
    const block = blockOf(node);
    if (started && block !== prevBlock) pendingSpace = true;
    prevBlock = block;
    const raw = node.nodeValue ?? '';
    for (let i = 0; i < raw.length; i++) {
      if (/\s/.test(raw[i])) {
        if (started) pendingSpace = true;
        continue;
      }
      if (pendingSpace) {
        // Anchored to the character it precedes, so a Range never starts on a
        // separator that has no node of its own.
        text += ' ';
        at.push({ node, offset: i });
        pendingSpace = false;
      }
      text += raw[i];
      at.push({ node, offset: i });
      started = true;
    }
  }
  return { text, at };
}

/** The same collapse `flattenText` applies, for the stored quote. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Locate each comment's quote in the rendered plan.
 *
 * Best-effort by design: the plan file is re-read from disk while the card is
 * open, so a passage the agent has since rewritten is simply not found and not
 * painted. The comment still rides in the list below and still reaches the model
 * — losing the highlight is the whole of the degradation.
 *
 * Occurrences are claimed left to right, so two comments on the same repeated
 * phrase land on different instances of it rather than stacking on the first.
 */
function locateQuotes(
  root: HTMLElement,
  comments: PlanComment[],
): Map<string, Range> {
  const found = new Map<string, Range>();
  if (comments.length === 0) return found;
  const { text, at } = flattenText(root);
  if (!text) return found;
  let claimedTo = 0;
  for (const c of comments) {
    const needle = collapseWhitespace(c.quote);
    if (!needle) continue;
    // Retry from the top: comments are stored in the order they were written,
    // which need not be the order the passages appear in.
    let start = text.indexOf(needle, claimedTo);
    if (start === -1) start = text.indexOf(needle);
    if (start === -1) continue;
    const end = start + needle.length - 1;
    const from = at[start];
    const to = at[end];
    if (!from || !to) continue;
    const range = document.createRange();
    try {
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset + 1);
    } catch {
      // A node detached between the walk and here (a re-render mid-loop). The
      // observer that scheduled this run will schedule another.
      continue;
    }
    found.set(c.id, range);
    claimedTo = end + 1;
  }
  return found;
}

/**
 * The plan body, with a select-to-comment affordance over it.
 *
 * Own component rather than a helper because the card renders the plan twice —
 * inline and in focus mode — and each copy needs its own selection, its own
 * floating icon and its own overlay. Sharing one piece of state between them
 * would put the icon of one over the text of the other.
 *
 * All coordinates are wrapper-relative, never viewport: the inline copy sits
 * inside a `ScrollArea`, so a viewport offset would slide off the passage it
 * points at the moment the user scrolls.
 */
function CommentablePlan({
  text,
  readOnly,
  onAdd,
  comments,
  activeId,
  onHover,
  onEditComment,
  onDeleteComment,
  scrollToActive,
  fz,
}: {
  text: string;
  /** A resolved card is a record, not a review — no affordance on it. */
  readOnly?: boolean;
  onAdd: (quote: string, note: string) => void;
  /** Painted onto the plan body wherever their quotes can still be found. */
  comments: PlanComment[];
  /** The comment to emphasize, whether its row or its passage is under the pointer. */
  activeId?: string | null;
  /** Reports the passage the pointer is over, so the matching row lights up too. */
  onHover?: (id: string | null) => void;
  /** Rewrite a note from the hover bubble; same handler the list row uses. */
  onEditComment?: (id: string, note: string) => void;
  onDeleteComment?: (id: string) => void;
  /** Only the copy the user is looking at may scroll to the active passage. */
  scrollToActive?: boolean;
  fz?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<{ quote: string; left: number; top: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  // Identifies this copy's contribution to the shared highlight registry.
  const instanceId = useId();
  /** Where each comment's quote currently sits, refreshed on every paint. */
  const locatedRef = useRef<Map<string, Range>>(new Map());
  /** The comment whose passage the pointer is over, with its anchor. */
  const [peek, setPeek] = useState<{ comment: PlanComment; left: number; top: number } | null>(null);
  /** The bubble has been switched from reading the note to rewriting it. */
  const [peekEditing, setPeekEditing] = useState(false);
  const [peekDraft, setPeekDraft] = useState('');
  /** Grace period before the bubble closes, so it can be moved onto. */
  const hideTimer = useRef<number | null>(null);
  // Read by the close timer, which captured `peekEditing` when it was scheduled —
  // an edit started *after* that would otherwise be closed out from under itself.
  const peekEditingRef = useRef(false);
  peekEditingRef.current = peekEditing;
  useEffect(() => () => cancelHide(), []);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    // Only the first paint of each run may scroll. Later ones come from the
    // observer — a markdown re-render fires a burst of them, and scrolling on
    // every one would fight the user for the scrollbar.
    let mayScroll = true;
    const paint = () => {
      const found = locateQuotes(wrap, comments);
      const active = activeId ? found.get(activeId) : undefined;
      planHighlights.set(instanceId, {
        // The active one is painted by its own rule; leaving it in both would
        // stack two translucent fills on the same text.
        all: [...found.entries()].filter(([id]) => id !== activeId).map(([, r]) => r),
        active: active ? [active] : [],
      });
      republishPlanHighlights();
      // Kept for the pointer hit-test below. A Range is live, so the rects it
      // reports stay correct as the card scrolls or reflows.
      locatedRef.current = found;
      if (active && scrollToActive && mayScroll) {
        // 'nearest' is a no-op when the passage is already on screen, so hovering
        // a comment whose text is visible never jolts the view.
        active.startContainer.parentElement?.scrollIntoView({ block: 'nearest' });
      }
      mayScroll = false;
    };
    paint();
    // The markdown re-renders after mount (lite -> full plugins) and again on
    // every live re-read of the plan file, replacing the nodes the Ranges point
    // at. Painting mutates no DOM, so watching for that cannot loop.
    const observer = new MutationObserver(paint);
    observer.observe(wrap, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      planHighlights.delete(instanceId);
      republishPlanHighlights();
    };
  }, [text, comments, activeId, scrollToActive, instanceId]);

  const close = () => {
    setEditing(false);
    setPending(null);
    setNote('');
  };

  const captureSelection = () => {
    // While the overlay is open the selection is stale by definition — clicking
    // into the textarea collapses it — so nothing may clear the anchor it is
    // positioned against.
    // peekEditing included: dragging a selection while a note is open would
    // otherwise throw the half-written note away to make room for a new one.
    if (readOnly || editing || peekEditing) return;
    const wrap = wrapRef.current;
    const sel = window.getSelection();
    if (!wrap || !sel || sel.isCollapsed || sel.rangeCount === 0) {
      setPending(null);
      return;
    }
    const range = sel.getRangeAt(0);
    // Another copy of the plan, or something else on the page entirely.
    if (!wrap.contains(range.commonAncestorContainer)) {
      setPending(null);
      return;
    }
    const quote = sel.toString().trim();
    if (!quote) {
      setPending(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    // A selection that started on an existing highlight would otherwise leave its
    // bubble sitting under the comment icon.
    clearHover();
    setPending({
      quote,
      left: rect.right - wrapRect.left,
      top: rect.bottom - wrapRect.top,
    });
  };

  /**
   * Which commented passage is under the pointer, resolved geometrically.
   *
   * A CSS Highlight is not an element — it has no box and receives no events — so
   * hovering it has to be hit-tested against the Ranges' client rects. Same
   * approach MentionInput uses for its pill mirror, and one rect per wrapped line
   * for the same reason.
   */
  const trackHover = (e: React.MouseEvent) => {
    const wrap = wrapRef.current;
    // Mid-selection or mid-write, a bubble under the cursor is in the way. And
    // while a note is being rewritten, drifting over a *different* passage must
    // not swap the bubble out and discard it.
    if (!wrap || editing || pending || peekEditing) return;
    // The pointer is on the bubble itself, which sits over the very passage that
    // opened it. Hit-testing here would miss and close the thing being reached for.
    if ((e.target as Element | null)?.closest?.('[data-plan-peek]')) return;
    const { clientX, clientY } = e;
    const wrapRect = wrap.getBoundingClientRect();
    for (const [id, range] of locatedRef.current) {
      for (const rect of range.getClientRects()) {
        if (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        ) {
          const comment = comments.find((c) => c.id === id);
          if (!comment) continue;
          cancelHide();
          const left = rect.left - wrapRect.left;
          const top = rect.bottom - wrapRect.top;
          setPeek((p) =>
            p && p.comment.id === id && p.left === left && p.top === top
              ? p
              : { comment, left, top },
          );
          onHover?.(id);
          return;
        }
      }
    }
    scheduleHide();
  };

  const cancelHide = () => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  /**
   * Close the bubble, but not instantly.
   *
   * Reaching the bubble means crossing the few pixels of uncommented text between
   * the passage and it — a hit-test miss that, closed eagerly, would snatch the
   * bubble away every time somebody tried to press one of its buttons.
   */
  const scheduleHide = () => {
    // An open editor is dismissed by Save, Cancel or Esc, never by the pointer
    // wandering off the half-written note.
    if (peekEditing) return;
    if (hideTimer.current !== null) return;
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      if (peekEditingRef.current) return;
      setPeek(null);
      onHover?.(null);
    }, 220);
  };

  const clearHover = () => {
    cancelHide();
    setPeek(null);
    setPeekEditing(false);
    onHover?.(null);
  };

  const savePeek = () => {
    const body = peekDraft.trim();
    if (!peek || !body) return;
    onEditComment?.(peek.comment.id, body);
    setPeekEditing(false);
    // The note in `peek` is a snapshot taken when the bubble opened; the next
    // paint re-reads it from the updated list.
    setPeek((p) => (p ? { ...p, comment: { ...p.comment, note: body } } : p));
  };

  const save = () => {
    const body = note.trim();
    if (!pending || !body) return;
    onAdd(pending.quote, body);
    // The passage has been captured — leaving it highlighted would suggest a
    // second comment is being written against it.
    window.getSelection()?.removeAllRanges();
    close();
  };

  return (
    <Box
      ref={wrapRef}
      style={{ position: 'relative' }}
      fz={fz}
      onMouseUp={captureSelection}
      // Keyboard selection (shift+arrows) never fires a mouseup.
      onKeyUp={captureSelection}
      onMouseMove={trackHover}
      onMouseLeave={scheduleHide}
    >
      <Markdown text={text} />
      {peek && (
        <Paper
          withBorder
          shadow="md"
          radius="sm"
          p={8}
          data-plan-chrome
          data-plan-peek
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
          style={{
            position: 'absolute',
            left: peek.left,
            // Butted right up against the passage: every pixel of gap is a place
            // the pointer can land and start the close timer.
            top: peek.top + 2,
            zIndex: 5,
            width: peekEditing ? 300 : undefined,
            maxWidth: 320,
          }}
        >
          <Group gap={6} wrap="nowrap" mb={2} justify="space-between">
            <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
              <IconMessagePlus size={12} color="var(--mantine-color-orange-6)" />
              <Text size="10px" c="dimmed" tt="uppercase" fw={700}>
                Your comment
              </Text>
            </Group>
            {!peekEditing && (
              <Group gap={2} wrap="nowrap">
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="gray"
                  aria-label="Edit comment"
                  onClick={() => {
                    cancelHide();
                    setPeekDraft(peek.comment.note);
                    setPeekEditing(true);
                  }}
                >
                  <IconPencil size={12} />
                </ActionIcon>
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="gray"
                  aria-label="Delete comment"
                  onClick={() => {
                    onDeleteComment?.(peek.comment.id);
                    // Its passage is about to stop being highlighted, so the
                    // bubble anchored to it has nothing left to point at.
                    clearHover();
                  }}
                >
                  <IconTrash size={12} />
                </ActionIcon>
              </Group>
            )}
          </Group>
          {peekEditing ? (
            <>
              <Textarea
                autosize
                minRows={2}
                maxRows={6}
                size="xs"
                autoFocus
                value={peekDraft}
                onChange={(e) => setPeekDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setPeekEditing(false);
                  }
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    savePeek();
                  }
                }}
              />
              <Group gap="xs" justify="flex-end" mt={6}>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  onClick={() => setPeekEditing(false)}
                >
                  Cancel
                </Button>
                <Button size="compact-xs" disabled={!peekDraft.trim()} onClick={savePeek}>
                  Save
                </Button>
              </Group>
            </>
          ) : (
            <Text size="xs" style={{ whiteSpace: 'pre-wrap' }}>
              {peek.comment.note}
            </Text>
          )}
        </Paper>
      )}
      {pending && !editing && (
        <Tooltip label="Comment on this passage">
          <ActionIcon
            size="sm"
            variant="filled"
            data-plan-chrome
            style={{ position: 'absolute', left: pending.left, top: pending.top + 4, zIndex: 3 }}
            // The click must not collapse the selection before we have read it.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEditing(true)}
            aria-label="Comment on this passage"
          >
            <IconMessagePlus size={14} />
          </ActionIcon>
        </Tooltip>
      )}
      {pending && editing && (
        <Paper
          withBorder
          shadow="md"
          radius="sm"
          p={8}
          data-plan-chrome
          style={{
            position: 'absolute',
            // Pulled back from the anchor so a selection ending at the right
            // edge does not push the overlay outside the card.
            left: Math.max(0, pending.left - 240),
            top: pending.top + 4,
            zIndex: 4,
            width: 280,
          }}
        >
          <Text size="10px" c="dimmed" lineClamp={2}>
            “{pending.quote}”
          </Text>
          <Textarea
            autosize
            minRows={2}
            maxRows={6}
            size="xs"
            mt={4}
            data-autofocus
            autoFocus
            placeholder="What should change here?"
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                close();
              }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
          />
          <Group gap="xs" justify="flex-end" mt={6}>
            <Button size="compact-xs" variant="subtle" color="gray" onClick={close}>
              Cancel
            </Button>
            <Button size="compact-xs" disabled={!note.trim()} onClick={save}>
              Save
            </Button>
          </Group>
        </Paper>
      )}
    </Box>
  );
}

/**
 * Plan review with a distraction-free full-screen focus mode (auto-opens while pending).
 * A resolved plan stays readable: collapsed by default, one click from full text, but
 * with no action buttons — its requestId is dead.
 */
function PlanApproval({
  sessionId,
  data,
  resolution,
}: {
  sessionId: string;
  data: PermissionRequestData;
  resolution?: Resolution;
}) {
  // Auto-open fullscreen only if this tab is focused now; a background tab must not steal focus
  // when the user later switches to it (precedent: alerts.ts document.hasFocus() guard).
  const [focus, setFocus] = useState(() => document.hasFocus());
  // Pending cards render open as before; one loaded from history renders collapsed.
  const [expanded, setExpanded] = useState(!resolution);
  const plan = String(data.input.plan ?? '');
  // Set by withPlanFileText whenever the turn (or session) saw a plan-file write.
  const planPath = String(data.input.planPath ?? '') || undefined;
  const hasPlan = plan.trim().length > 0 || Boolean(planPath);

  // The captured text is a snapshot; the agent keeps revising the file across
  // "keep planning" rounds. Re-read it whenever the card opens — the snapshot
  // renders immediately (no empty flash) and live content swaps in on arrival.
  // A failed read (deleted plan, 403) silently keeps the snapshot.
  const open = expanded || focus;
  const [reloadKey, setReloadKey] = useState(0);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) setReloadKey((k) => k + 1);
    wasOpen.current = open;
  }, [open]);
  const { content } = useFileContent(open ? planPath : undefined, reloadKey);
  const shown = content ?? plan;
  const revised = Boolean(content && content !== plan);

  // If the plan arrived while this tab was in the background, open focus mode once when the tab
  // regains focus — unless the user has already dismissed it.
  const dismissed = useRef(false);
  useEffect(() => {
    if (focus || resolution) return;
    const onFocus = () => {
      if (!dismissed.current) setFocus(true);
    };
    window.addEventListener('focus', onFocus, { once: true });
    return () => window.removeEventListener('focus', onFocus);
  }, [focus, resolution]);

  // Resolving closes focus mode and collapses the card in place, so an approved plan stops
  // dominating live scrollback. Also fires when another client resolves it. Deps are
  // [resolution] only, so re-expanding a resolved card does not re-collapse it.
  useEffect(() => {
    if (!resolution) return;
    setFocus(false);
    setExpanded(false);
  }, [resolution]);

  const dismissFocus = () => {
    dismissed.current = true;
    setFocus(false);
  };

  const toggle = () => {
    if (hasPlan) setExpanded((v) => !v);
  };

  // Seeded from localStorage and written back on every change: this card is
  // unmounted and remounted freely as the transcript windows its tail, so
  // component-local state would lose a half-finished review to a scroll.
  const [comments, setComments] = useState<PlanComment[]>(() =>
    resolution ? [] : readPlanComments(sessionId, data.requestId),
  );
  useEffect(() => {
    // A resolved card's requestId is dead — drop its draft rather than
    // persisting comments no button can send any more.
    writePlanComments(sessionId, data.requestId, resolution ? [] : comments);
  }, [comments, resolution, sessionId, data.requestId]);

  // Which comment's passage to emphasize in the plan body. Hovering the row is
  // the whole interaction: the list says what was said, the highlight says where.
  const [activeId, setActiveId] = useState<string | null>(null);
  // The comment row currently open for rewriting, and the text in its box.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const addComment = (quote: string, note: string) =>
    // The same gate the server runs, so the cap and the truncation the model
    // will see are the ones the user sees on the card.
    setComments((prev) => normalizePlanComments([...prev, { id: crypto.randomUUID(), quote, note }]));
  const removeComment = (id: string) => setComments((prev) => prev.filter((c) => c.id !== id));
  /**
   * Rewrite one comment's note in place.
   *
   * The quote is deliberately not editable: it is the anchor the highlight is
   * located by, and it is the record of what the user actually selected. Editing
   * it would either unmoor the highlight or quietly misattribute a passage. To
   * comment on different text, select that text.
   */
  const updateComment = (id: string, note: string) =>
    setComments((prev) =>
      normalizePlanComments(prev.map((c) => (c.id === id ? { ...c, note } : c))),
    );

  const startEdit = (c: PlanComment) => {
    setEditingId(c.id);
    setEditDraft(c.note);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft('');
  };
  const saveEdit = (id: string) => {
    const body = editDraft.trim();
    // Matches the create overlay: an empty note is not a comment, so Save is
    // disabled rather than silently deleting the row out from under the user.
    if (!body) return;
    updateComment(id, body);
    cancelEdit();
  };

  /**
   * Which passage the plan body emphasizes. Editing outranks hovering: with the
   * caret in a Textarea the pointer is somewhere else entirely, and losing the
   * highlight would leave you rewriting a note with no idea which passage it is on.
   */
  const emphasizedId = editingId ?? activeId;

  const commented = comments.length > 0;
  // Only when there are comments: with none this is exactly the message the card
  // sent before this feature existed.
  const payload = commented ? comments : undefined;
  const approve = () => respond(sessionId, data.requestId, true, undefined, payload);
  const keepPlanning = () =>
    respond(sessionId, data.requestId, false, KEEP_PLANNING_MESSAGE, payload);
  const reply = planReplyText(data);

  // One definition, rendered at two sizes — the inline card and the focus-mode
  // footer used to carry their own copies of these buttons and could drift.
  const renderActions = (size: 'xs' | 'sm') => (
    <Group gap="xs">
      <Button size={size} onClick={approve}>
        {commented ? `Approve with comments (${comments.length})` : 'Approve plan & start'}
      </Button>
      <Button size={size} variant="default" onClick={keepPlanning}>
        {commented ? `Refine with comments (${comments.length})` : 'Keep planning'}
      </Button>
    </Group>
  );

  const commentList = commented ? (
    <Box mt="sm">
      <Text size="xs" fw={600} c="dimmed" mb={4}>
        {comments.length} comment{comments.length === 1 ? '' : 's'}
      </Text>
      <Stack gap={6}>
        {comments.map((c) => (
          <Group
            key={c.id}
            gap="xs"
            wrap="nowrap"
            align="flex-start"
            onMouseEnter={() => setActiveId(c.id)}
            onMouseLeave={() => setActiveId((id) => (id === c.id ? null : id))}
          >
            <Box
              style={{
                minWidth: 0,
                flex: 1,
                paddingLeft: 8,
                // Matches ::highlight(lines-plan-comment-active) in index.css, so
                // the row and the passage it points at read as one thing.
                borderLeft: `2px solid ${
                  emphasizedId === c.id
                    ? 'var(--mantine-color-orange-5)'
                    : 'var(--mantine-color-default-border)'
                }`,
              }}
            >
              {c.quote && (
                <Text size="10px" c="dimmed" lineClamp={1}>
                  “{c.quote}”
                </Text>
              )}
              {editingId === c.id ? (
                <>
                  <Textarea
                    autosize
                    minRows={2}
                    maxRows={6}
                    size="xs"
                    mt={2}
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelEdit();
                      }
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        saveEdit(c.id);
                      }
                    }}
                  />
                  <Group gap="xs" justify="flex-end" mt={4}>
                    <Button size="compact-xs" variant="subtle" color="gray" onClick={cancelEdit}>
                      Cancel
                    </Button>
                    <Button
                      size="compact-xs"
                      disabled={!editDraft.trim()}
                      onClick={() => saveEdit(c.id)}
                    >
                      Save
                    </Button>
                  </Group>
                </>
              ) : (
                <Text
                  size="xs"
                  style={{ whiteSpace: 'pre-wrap', cursor: 'text' }}
                  // The text itself is the target most people reach for; the
                  // pencil is there for the ones who look for a control.
                  onClick={() => startEdit(c)}
                >
                  {c.note}
                </Text>
              )}
            </Box>
            {editingId !== c.id && (
              <>
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="gray"
                  onClick={() => startEdit(c)}
                  aria-label="Edit comment"
                >
                  <IconPencil size={12} />
                </ActionIcon>
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="gray"
                  onClick={() => removeComment(c.id)}
                  aria-label="Delete comment"
                >
                  <IconTrash size={12} />
                </ActionIcon>
              </>
            )}
          </Group>
        ))}
      </Stack>
    </Box>
  ) : null;

  return (
    <>
      <Paper
        withBorder
        radius="md"
        p="sm"
        style={{ borderColor: resolution ? undefined : 'var(--mantine-color-sandstone-6)' }}
      >
        <Group
          className="tx-row"
          gap="xs"
          justify="space-between"
          mb={expanded ? 8 : 0}
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
            {/* The chevron's slot always exists — a prompt carrying no plan marks it
                with a dot so its icon and title stay in the same column. */}
            {hasPlan ? (
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
            <IconMap size={16} color="var(--mantine-color-sandstone-5)" />
            <Text size="sm" fw={600}>
              Claude finished planning
            </Text>
            {resolution && (
              <ResolutionBadge
                data={data}
                color={resolution === 'deny' ? 'sandstone' : RESOLUTION_BADGE[resolution].color}
              >
                {resolution === 'allow' ? 'plan approved' : null}
                {/* A denied plan is not a rejection — the session stayed in plan mode. */}
                {resolution === 'deny' ? 'kept planning' : null}
                {resolution === 'expired' ? RESOLUTION_BADGE[resolution].label : null}
              </ResolutionBadge>
            )}
            {resolution && revised && (
              <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                updated since approval
              </Text>
            )}
            {!expanded && hasPlan && (
              <Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
                {planHeadline(shown)}
              </Text>
            )}
          </Group>
          <Tooltip label={hasPlan ? 'Focus mode' : 'Plan text unavailable'}>
            <ActionIcon
              size="sm"
              variant="light"
              disabled={!hasPlan}
              // Sits inside the header's click target — don't toggle the card too.
              onClick={(e) => {
                e.stopPropagation();
                dismissed.current = false;
                setFocus(true);
              }}
            >
              <IconArrowsMaximize size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
        {resolution && reply && <PlanReply data={data} text={reply} />}
        <Collapse expanded={expanded} transitionDuration={150}>
          <ScrollArea.Autosize mah={320} type="auto">
            {/* Not default-hover: that shade now reads as a user bubble. */}
            <Paper bg="var(--mantine-color-default)" radius="md" px="sm" py={4}>
              <CommentablePlan
                text={shown}
                readOnly={!!resolution}
                onAdd={addComment}
                comments={comments}
                activeId={emphasizedId}
                onHover={setActiveId}

                onEditComment={updateComment}

                onDeleteComment={removeComment}
                // The focus-mode copy is on top when it is open; only the one the
                // user can actually see may scroll itself.
                scrollToActive={!focus}
              />
            </Paper>
          </ScrollArea.Autosize>
          {/* Buttons never render for a dead requestId. */}
          {!resolution && commentList}
          {!resolution && <Box mt="sm">{renderActions('xs')}</Box>}
        </Collapse>
      </Paper>

      <Modal
        opened={focus}
        onClose={dismissFocus}
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
            <Button variant="subtle" color="gray" size="xs" onClick={dismissFocus}>
              Exit focus (Esc)
            </Button>
          </Group>
          <ScrollArea style={{ flex: 1 }}>
            <Box maw={760} mx="auto" px="xl" pb="xl">
              <CommentablePlan
                text={shown}
                readOnly={!!resolution}
                onAdd={addComment}
                comments={comments}
                activeId={emphasizedId}
                onHover={setActiveId}

                onEditComment={updateComment}

                onDeleteComment={removeComment}
                scrollToActive={focus}
                fz="md"
              />
              {!resolution && commentList}
            </Box>
          </ScrollArea>
          {/* A resolved plan opens read-only — the footer and its border go with the buttons. */}
          {!resolution && (
            <Group
              justify="center"
              py="md"
              style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
            >
              {renderActions('sm')}
            </Group>
          )}
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
    <PermissionCard sessionId={sessionId} data={data} resolution={resolution} p={p} />
  );
}

/**
 * The card body, split out so the guest branch is a single early return rather
 * than a conditional threaded through every button.
 */
function PermissionCard({
  sessionId,
  data,
  resolution,
  p,
}: {
  sessionId: string;
  data: PermissionRequestData;
  resolution?: Resolution;
  p: ReturnType<typeof toolPresentation>;
}) {
  // A guest without `approvePermissions` sees the request read-only. Answering it
  // runs a command on the host's machine, as them, so no preset below
  // Collaborator reaches it — and a button that always errors is worse than none.
  const canApprove = useCan('approvePermissions');
  const owner = useStore((s) => s.access?.ownerProfile ?? null);

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
          <ResolutionBadge data={data} color={RESOLUTION_BADGE[resolution].color}>
            {RESOLUTION_BADGE[resolution].label}
          </ResolutionBadge>
        )}
      </Group>
      {resolution === 'expired' && (
        <Text size="xs" c="dimmed" mt={4}>
          This request is no longer active (the turn ended or the server restarted). Re-send your
          prompt to continue.
        </Text>
      )}
      {!resolution && !canApprove && (
        <Text size="xs" c="dimmed" mt={4}>
          Waiting for {owner?.name ?? owner?.email ?? 'the owner'} to approve this.
        </Text>
      )}
      {!resolution && canApprove && (
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
