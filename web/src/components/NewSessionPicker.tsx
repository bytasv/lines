import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Anchor,
  Button,
  Group,
  Loader,
  Modal,
  ScrollArea,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconGitBranch, IconSearch } from '@tabler/icons-react';
import type { SessionMeta, StepContent, WorkflowDef, WorkflowStepOverride } from '@lines/shared';
import { findWorktree } from '@lines/shared';
import { activeGroupKey, prefsFor, projectAt, sessionsInProject, useStore } from '../store';
import { useCanOnSession } from '../lib/can';
import { MOD } from '../lib/platform';
import { recentWorkflows } from '../lib/recentWorkflows';
import { useLaunchableWorkflows } from '../lib/useLaunchableWorkflows';
import { useCreateSession, useSetPendingWorkflow, useWorktreePref } from '../lib/useCreateSession';
import { useStepResolver } from '../lib/useStepResolver';
import { UntrustedBadge } from './workflow/UntrustedReview';
import { StepOverrideRows, useStepOverrideRows } from './workflow/WorkflowRunModal';
import styles from './NewSessionPicker.module.css';

const GRID_COLS = { base: 1, xs: 2, sm: 3 };
/** The recent row carries the Chat card too. */
const RECENT_COLS = { base: 1, xs: 2, sm: 4 };

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * What an empty session shows while nothing has been sent: it is a bare session
 * by default, and picking a workflow here attaches it (`setPendingWorkflow`) to
 * wait for the first prompt, as a workflow chosen at create would. The composer
 * below stays the way to start either.
 */
export function NewSessionPicker({ session }: { session: SessionMeta }) {
  const canCreate = useCanOnSession(session.id, 'createSessions');
  const launchable = useLaunchableWorkflows();
  const sessions = useStore((s) => s.sessions);
  const projectKeys = useStore((s) => s.projectKeys);
  const projects = useStore((s) => s.projects);
  const activeProject = useStore((s) => s.activeProject);
  const prefsKey = useStore(activeGroupKey);
  const sessionPrefs = useStore((s) => s.sessionPrefs);
  const legacySidebarMode = useStore((s) => s.sidebarMode);
  const setPending = useSetPendingWorkflow();
  const requestComposerFocus = useStore((s) => s.requestComposerFocus);
  const [browsing, setBrowsing] = useState(false);
  const [query, setQuery] = useState('');
  const [tuning, setTuning] = useState<WorkflowDef | null>(null);
  const isGuest = useStore((s) => s.access !== null);
  const worktreePending = useStore((s) => s.worktreePending);
  const pendingCreate = useStore((s) => s.pendingCreate);
  const [, setWorktreePref] = useWorktreePref();
  const createSession = useCreateSession();

  const recent = useMemo(() => {
    const project = projectAt(projects, activeProject);
    const inProject = project ? sessionsInProject(sessions, projectKeys, project) : Object.values(sessions);
    const fallback = prefsFor({ sessionPrefs, sidebarMode: legacySidebarMode }, prefsKey).newSessionChoice;
    return recentWorkflows(
      inProject.filter((s) => s.id !== session.id),
      launchable.all,
      3,
      fallback || undefined,
    );
  }, [sessions, projectKeys, projects, activeProject, launchable.all, sessionPrefs, legacySidebarMode, prefsKey, session.id]);

  if (!canCreate) return null;

  const selectedId = session.workflow?.workflowId ?? null;
  const selectedWorkflow = selectedId
    ? (launchable.all.find((w) => w.id === selectedId) ?? session.workflow?.def)
    : undefined;
  // The picked workflow always has its card in the row, even when it came from
  // Browse all rather than from the recent ones.
  const shownRecent: WorkflowDef[] = recent.map((r) => r.def);
  if (selectedWorkflow && !shownRecent.some((w) => w.id === selectedWorkflow.id)) {
    shownRecent.unshift(selectedWorkflow);
    shownRecent.splice(3);
  }
  const lastRun = new Map(recent.map((r) => [r.def.id, r.lastRunAt]));

  const pick = (def: WorkflowDef, stepOverrides?: (WorkflowStepOverride | null)[]) => {
    if (setPending(session.id, def.id, stepOverrides)) requestComposerFocus(session.id);
  };
  const bare = () => {
    if (selectedId) setPending(session.id, null);
    requestComposerFocus(session.id);
  };

  /**
   * The working directory is the session's identity and is never rewritten, so
   * moving a fresh session into (or out of) a work tree re-creates it there with
   * the same choices, and drops this one once the new one is on screen. The
   * switch is also the project's default for the next new session.
   */
  const worktree = findWorktree(projects, session.cwd);
  const setWorktree = (on: boolean) => {
    setWorktreePref(on);
    const wf = session.workflow;
    // Only a tree Lines cut for this very session, still unbranched, goes with it.
    const own =
      worktree?.worktree.createdByLines && worktree.worktree.sessionId === session.id && !worktree.worktree.branch;
    createSession(wf?.workflowId, {
      worktree: on,
      ...(wf
        ? { stepOverrides: wf.stepOverrides }
        : { model: session.model, permissionMode: session.permissionMode, reasoningEffort: session.reasoningEffort }),
      replaces: {
        sessionId: session.id,
        ...(own ? { worktree: { project: worktree.project.path, path: worktree.worktree.path } } : {}),
      },
    });
  };
  const onCard = (e: ReactMouseEvent, def: WorkflowDef) => {
    if (e.metaKey || e.ctrlKey) {
      setTuning(launchable.resolveWorkflow(def.id) ?? def);
      return;
    }
    pick(def);
  };

  const card = (def: WorkflowDef) => (
    <WorkflowCard
      key={def.id}
      def={def}
      flow={launchable.resolveWorkflow(def.id) ?? def}
      selected={def.id === selectedId}
      lastRunAt={lastRun.get(def.id)}
      foreign={launchable.foreignWorkflows.some((w) => w.id === def.id)}
      onClick={(e) => onCard(e, def)}
    />
  );

  const q = query.trim().toLowerCase();
  const matches = (w: WorkflowDef) => !q || w.name.toLowerCase().includes(q);
  const own = [...launchable.workflows, ...launchable.ownWorkflows].filter(matches);
  const foreign = launchable.foreignWorkflows.filter(matches);
  const total = launchable.all.length;

  return (
    <ScrollArea className={styles.scroll} scrollbars="y">
      <Stack gap={14} maw={920} mx="auto" px="md" pb="xl" className={styles.body}>
        <div className={styles.header}>
          <div className={styles.titles}>
            <Text className={styles.title}>How do you want to start?</Text>
            <Text size="sm" c="dimmed">
              Chat directly, or hand your first prompt to a workflow.
            </Text>
          </div>
          {/* Cutting a work tree runs git on the host's disk: the host's call only. */}
          {!isGuest && (
            <Tooltip
              label={
                <>
                  <Text size="xs" fw={600}>
                    Run in a git worktree
                  </Text>
                  <Text size="xs">
                    Lines checks out a separate copy of the repo on a new branch for this session. Its changes stay
                    off your current checkout until you merge them.
                  </Text>
                </>
              }
              multiline
              w={260}
              position="bottom-end"
              openDelay={250}
            >
              <div className={styles.worktree} data-on={worktree ? true : undefined}>
                <IconGitBranch size={14} className={styles.worktreeIcon} />
                {worktreePending && <Loader size={12} />}
                <Switch
                  size="xs"
                  label="Worktree"
                  labelPosition="left"
                  classNames={{ label: styles.worktreeLabel }}
                  checked={!!worktree}
                  disabled={worktreePending || pendingCreate}
                  onChange={(e) => setWorktree(e.currentTarget.checked)}
                />
              </div>
            </Tooltip>
          )}
        </div>
        {total === 0 ? (
          <Text size="sm" c="dimmed">
            No workflows yet. Send a prompt to start a chat.
          </Text>
        ) : browsing ? (
          <Stack gap="sm">
            <Group justify="space-between" wrap="nowrap">
              <TextInput
                size="xs"
                placeholder="Search workflows"
                leftSection={<IconSearch size={14} />}
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                style={{ flex: 1, maxWidth: 320 }}
                autoFocus
              />
              <Anchor component="button" size="xs" onClick={() => setBrowsing(false)}>
                ← Recent
              </Anchor>
            </Group>
            {own.length > 0 && (
              <>
                <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                  Yours
                </Text>
                <SimpleGrid cols={GRID_COLS} spacing="sm">
                  {own.map(card)}
                </SimpleGrid>
              </>
            )}
            {foreign.length > 0 && (
              <>
                <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                  Shared by others
                </Text>
                <SimpleGrid cols={GRID_COLS} spacing="sm">
                  {foreign.map(card)}
                </SimpleGrid>
              </>
            )}
            {own.length + foreign.length === 0 && (
              <Text size="sm" c="dimmed">
                No workflow matches “{query.trim()}”.
              </Text>
            )}
          </Stack>
        ) : (
          <Stack gap={14}>
            <Group justify="space-between" pt={8}>
              <Text className={styles.sectionLabel}>Recent</Text>
              <Anchor component="button" className={styles.browse} onClick={() => setBrowsing(true)}>
                Browse all workflows →
              </Anchor>
            </Group>
            <SimpleGrid cols={RECENT_COLS} spacing={14}>
              <ChatCard selected={!selectedId} onClick={bare} />
              {shownRecent.map(card)}
            </SimpleGrid>
            {shownRecent.length === 0 && (
              <Text size="sm" c="dimmed">
                No workflow has run in this project yet.
              </Text>
            )}
            <Text size="xs" c="dimmed">
              Tip: {MOD}-click a card to pick each step’s model first.
            </Text>
          </Stack>
        )}
      </Stack>
      {tuning && (
        <TuneModal
          workflow={tuning}
          onClose={() => setTuning(null)}
          onConfirm={(overrides) => {
            const def = tuning;
            setTuning(null);
            pick(def, overrides);
          }}
        />
      )}
    </ScrollArea>
  );
}

/** The selected card's ring and check: drawn over the card so hover never touches them. */
function SelectedMark() {
  return (
    <>
      <span className={styles.ring} aria-hidden />
      <span className={styles.check} aria-hidden>
        <IconCheck size={12} stroke={3.2} />
      </span>
    </>
  );
}

/** No workflow: the composer's model, mode and effort, prompt by prompt. */
function ChatCard({ selected, onClick }: { selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={styles.card}
      data-selected={selected || undefined}
      aria-pressed={selected}
      onClick={onClick}
    >
      <div className={`${styles.thumb} ${styles.chatThumb}`}>
        <div className={styles.bubble}>
          <span className={styles.bubbleDot} />
          <span className={styles.bubbleDot} />
          <span className={styles.bubbleDot} />
        </div>
      </div>
      <div className={styles.meta}>
        <Text size="sm" fw={600} truncate>
          Chat
        </Text>
        <Text size="xs" c="dimmed" truncate>
          No workflow · composer settings
        </Text>
      </div>
      {selected && <SelectedMark />}
    </button>
  );
}

function WorkflowCard({
  def,
  flow,
  selected,
  lastRunAt,
  foreign,
  onClick,
}: {
  def: WorkflowDef;
  /** The def as it would run (an own workflow inlined), for the step flow. */
  flow: WorkflowDef;
  selected: boolean;
  lastRunAt?: number;
  foreign: boolean;
  onClick: (e: ReactMouseEvent) => void;
}) {
  // R2 down or misconfigured, or a URL the CSP refuses: fall back to the steps.
  const [broken, setBroken] = useState<string | null>(null);
  const cover = def.images?.[0];
  const n = def.steps.length;
  return (
    <button
      type="button"
      className={styles.card}
      data-selected={selected || undefined}
      aria-pressed={selected}
      onClick={onClick}
    >
      <div className={styles.thumb}>
        {cover && broken !== cover ? (
          <img src={cover} alt="" className={styles.cover} onError={() => setBroken(cover)} />
        ) : (
          <StepFlowThumb def={flow} />
        )}
      </div>
      <div className={styles.meta}>
        <Group gap={6} wrap="nowrap">
          <Text size="sm" fw={600} truncate style={{ flex: 1, minWidth: 0 }}>
            {def.name || 'Untitled workflow'}
          </Text>
          <UntrustedBadge mark={def.untrusted} ownerName={def.ownerName} />
        </Group>
        <Text size="xs" c="dimmed" truncate>
          {n} step{n === 1 ? '' : 's'}
          {lastRunAt !== undefined ? ` · ${ago(lastRunAt)}` : foreign && def.ownerName ? ` · by ${def.ownerName}` : ''}
        </Text>
      </div>
      {selected && <SelectedMark />}
    </button>
  );
}

/**
 * A workflow drawn as its steps: a horizontal chain of numbered dots, each with
 * its name. A chain wider than the card runs off the right edge under a fade.
 */
function StepFlowThumb({ def }: { def: WorkflowDef }) {
  const { resolveStepContent } = useStepResolver();
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [def.steps.length]);
  return (
    <div ref={ref} className={styles.flow} data-overflow={overflows || undefined}>
      <div className={styles.chain}>
        {def.steps.map((step, i) => {
          const content: StepContent | undefined = resolveStepContent(step);
          const name = content?.name ?? 'Pinned step';
          return (
            <div key={i} className={styles.step} title={name}>
              <div className={styles.rail}>
                <span className={styles.railLine} data-off={i === 0 || undefined} />
                <span className={styles.stepNum}>{i + 1}</span>
                <span className={styles.railLine} data-off={i === def.steps.length - 1 || undefined} />
              </div>
              <span className={styles.stepName}>{name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Cmd/Ctrl+click on a card: per-step model and effort for this run, then attach. */
function TuneModal({
  workflow,
  onClose,
  onConfirm,
}: {
  workflow: WorkflowDef;
  onClose: () => void;
  onConfirm: (overrides: (WorkflowStepOverride | null)[]) => void;
}) {
  const rows = useStepOverrideRows(workflow);
  return (
    <Modal opened onClose={onClose} title={workflow.name} size="lg">
      <Stack gap="sm">
        <StepOverrideRows state={rows} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(rows.overrides())}>Use workflow</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
