import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Avatar,
  Badge,
  Box,
  Button,
  Code,
  Collapse,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconArrowsMaximize,
  IconChevronDown,
  IconChevronRight,
  IconFilePencil,
  IconMap,
  IconShieldQuestion,
  IconTerminal2,
  IconWorld,
  IconZoomScan,
} from '@tabler/icons-react';
import type { PermissionRequestData, PermissionResolutionSource } from '@lines/shared';
import { KEEP_PLANNING_MESSAGE } from '@lines/shared';
import { send } from '../ws';
import { useStore } from '../store';
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

/** First non-empty plan line, markdown decoration stripped — the collapsed card's headline. */
function planHeadline(plan: string): string {
  const line = plan.split('\n').find((l) => l.trim().length > 0)?.replace(/^[#*\s>-]+/, '').trim() ?? '';
  return line.length > 100 ? line.slice(0, 100) + '…' : line;
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

  const approve = () => respond(sessionId, data.requestId, true);
  const keepPlanning = () => respond(sessionId, data.requestId, false, KEEP_PLANNING_MESSAGE);
  const reply = planReplyText(data);

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
            {hasPlan && (expanded ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />)}
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
        {resolution && reply && (
          <Text
            size="xs"
            c="dimmed"
            mt={8}
            pl="sm"
            style={{
              whiteSpace: 'pre-wrap',
              borderLeft: '2px solid var(--mantine-color-default-border)',
            }}
          >
            You: {reply}
          </Text>
        )}
        <Collapse expanded={expanded} transitionDuration={150}>
          <ScrollArea.Autosize mah={320} type="auto">
            {/* Not default-hover: that shade now reads as a user bubble. */}
            <Paper bg="var(--mantine-color-default)" radius="md" px="sm" py={4}>
              <Markdown text={shown} />
            </Paper>
          </ScrollArea.Autosize>
          {/* Buttons never render for a dead requestId. */}
          {!resolution && <Box mt="sm">{actions}</Box>}
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
            <Box maw={760} mx="auto" px="xl" pb="xl" fz="md">
              <Markdown text={shown} />
            </Box>
          </ScrollArea>
          {/* A resolved plan opens read-only — the footer and its border go with the buttons. */}
          {!resolution && (
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
