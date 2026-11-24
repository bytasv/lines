import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Drawer,
  Group,
  Loader,
  Menu,
  Modal,
  Paper,
  Popover,
  Select,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
  type MantineTransition,
} from '@mantine/core';
import { useHover } from '@mantine/hooks';
import {
  IconAdjustmentsHorizontal,
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconFile,
  IconMicrophone,
  IconPaperclip,
  IconSend,
  IconTarget,
  IconUpload,
  IconX,
  IconZoomIn,
} from '@tabler/icons-react';
import type {
  ClientMessage,
  ModelProvider,
  PermissionMode,
  PromptAttachment,
  ReasoningEffort,
  SessionMeta,
} from '@lines/shared';
import {
  hasEstimatedSpend,
  isSessionInterruptible,
  providerForModel,
  providerSwitchBlock,
  rootsForCwd,
} from '@lines/shared';
import { formatSpendUsd, isWorkflowFinished, stepAfterProviderSwitch, withLiveSpend } from '../lib/format';
import { useStepResolver } from '../lib/useStepResolver';
import { agentLabel, sessionCaps } from '../lib/capabilities';
import {
  readDraft,
  readDraftAttachments,
  useStore,
  writeDraft,
  writeDraftAttachments,
} from '../store';
import {
  AUTO_EFFORT,
  describedOptionRenderer,
  describedOptionStyles,
  effortSelectData,
  modelComboboxProps,
  modelSelectData,
  renderOptionWithDescription,
} from '../lib/modelSelect';
import {
  permissionModeLabel,
  PERMISSION_MODES,
  SEGMENT_MODES,
} from '../lib/permissionModes';
import { buildExpandedPrompt, type MentionValue, uniqueMentions } from '../lib/mentions';
import { linkedMachineHealth } from '../lib/machineHealth';
import { useCan, useSessionMachine, useSessionMachineHealth } from '../lib/can';
import { usePresence } from '../lib/presence';
import { ConfirmModal } from './ConfirmModal';
import { GoalModal } from './GoalModal';
import { GoalChip } from './GoalChip';
import { ContextWindowIndicator } from './ContextWindowIndicator';
import { SettingsModal, type SettingsSection } from './SettingsModal';
import { MentionInput, spliceTranscript, type MentionInputHandle } from './MentionInput';
import { VoiceWaveform } from './VoiceWaveform';
import { send } from '../ws';
import { formatElapsed, useVoiceDictation } from '../lib/useVoiceDictation';
import { DictateButton, VoiceLimitNotice } from './DictateButton';
import { useIsPhone } from '../lib/layout';
import { prepareAttachment } from '../lib/imageDownscale';
import styles from './Composer.module.css';

/**
 * Read a File into a raw-base64 PromptAttachment, downscaling large photos
 * first (see `prepareAttachment`). Kept here because QueuedMessages imports it.
 */
export function fileToAttachment(file: File): Promise<PromptAttachment> {
  return prepareAttachment(file);
}

/**
 * Send a composed prompt to `sessionId`. Module-level so a dictated Send can
 * still go out after its composer has unmounted.
 */
function sendPromptMessage(
  sessionId: string,
  value: MentionValue,
  attachments: PromptAttachment[],
  opts?: { queue?: boolean },
): void {
  // Bake the @mention expansions into the text (so workflow-first-prompt and
  // offline queueing see it too); `mentions` rides along display-only.
  const expanded = buildExpandedPrompt(value.text.trim(), value.ranges);
  const wireMentions = uniqueMentions(value.ranges).map(({ kind, id, label, detail }) => ({
    kind,
    id,
    label,
    detail,
  }));
  send({
    type: 'prompt',
    sessionId,
    text: expanded,
    attachments,
    mentions: wireMentions.length ? wireMentions : undefined,
    // Kept only if the server queues this prompt, so the queue row can be
    // re-opened in a composer with its pills instead of the expanded text.
    draft: value.ranges.length ? value : undefined,
    // "Do this after": hold until the turn settles instead of steering into it.
    queue: opts?.queue || undefined,
  });
}

/** Square attachment preview; images get a zoom-icon overlay on hover, a remove X on all. */
function PreviewTile({
  att,
  onOpen,
  onRemove,
}: {
  att: PromptAttachment;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const isImage = att.mediaType.startsWith('image/');
  const { hovered, ref } = useHover<HTMLDivElement>();
  return (
    <Paper
      ref={ref}
      withBorder
      radius="md"
      onClick={isImage ? onOpen : undefined}
      style={{
        position: 'relative',
        width: 64,
        height: 64,
        overflow: 'hidden',
        flexShrink: 0,
        cursor: isImage ? 'zoom-in' : 'default',
      }}
    >
      {isImage ? (
        <>
          <img
            src={`data:${att.mediaType};base64,${att.data}`}
            alt={att.name}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
          {hovered && (
            <Box
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0,0,0,0.45)',
              }}
            >
              <IconZoomIn size={20} color="white" />
            </Box>
          )}
        </>
      ) : (
        <Tooltip label={att.name}>
          <Stack align="center" justify="center" gap={2} h="100%" px={4}>
            <IconFile size={20} opacity={0.6} />
            <Text size="9px" ta="center" lineClamp={1} style={{ maxWidth: '100%' }}>
              {att.name}
            </Text>
          </Stack>
        </Tooltip>
      )}
      <ActionIcon
        size="xs"
        radius="xl"
        variant="filled"
        color="dark"
        style={{ position: 'absolute', top: 2, right: 2, zIndex: 2 }}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        <IconX size={10} />
      </ActionIcon>
    </Paper>
  );
}

/** `248 KB`, from the attachment's raw base64 length. */
function attachmentSize(att: PromptAttachment): string {
  const bytes = Math.round((att.data.length * 3) / 4);
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Desktop attachment chip: thumbnail, name and size, and a remove ×. */
function AttachmentChip({
  att,
  onOpen,
  onRemove,
}: {
  att: PromptAttachment;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const isImage = att.mediaType.startsWith('image/');
  return (
    <div className={styles.file}>
      {isImage ? (
        <UnstyledButton
          className={styles.fileThumb}
          aria-label={`Preview ${att.name}`}
          onClick={onOpen}
          style={{ cursor: 'zoom-in' }}
        >
          <img src={`data:${att.mediaType};base64,${att.data}`} alt={att.name} />
        </UnstyledButton>
      ) : (
        <div className={styles.fileThumb} />
      )}
      <div className={styles.fileMeta}>
        <div className={styles.fileName} title={att.name}>
          {att.name}
        </div>
        <div className={styles.fileSize}>{attachmentSize(att)}</div>
      </div>
      <UnstyledButton className={styles.fileRemove} aria-label={`Remove ${att.name}`} onClick={onRemove}>
        ×
      </UnstyledButton>
    </div>
  );
}

/**
 * Keeps an element mounted for `ms` after `show` turns off, so its exit
 * animation can play: `exiting` is the state to style it leaving.
 */
function useExitDelay(show: boolean, ms: number): 'hidden' | 'shown' | 'exiting' {
  const [state, setState] = useState<'hidden' | 'shown' | 'exiting'>(show ? 'shown' : 'hidden');
  useEffect(() => {
    if (show) {
      setState('shown');
      return;
    }
    setState((s) => (s === 'hidden' ? s : 'exiting'));
    const timer = setTimeout(() => setState('hidden'), ms);
    return () => clearTimeout(timer);
  }, [show, ms]);
  return state;
}

/** Menus rise into place from 6px below; popovers from 8px, slightly scaled. */
const MENU_TRANSITION: MantineTransition = {
  in: { opacity: 1, transform: 'translateY(0)' },
  out: { opacity: 0, transform: 'translateY(6px)' },
  transitionProperty: 'opacity, transform',
};
const POPOVER_TRANSITION: MantineTransition = {
  in: { opacity: 1, transform: 'translateY(0) scale(1)' },
  out: { opacity: 0, transform: 'translateY(8px) scale(0.96)' },
  transitionProperty: 'opacity, transform',
};
/** A spring's settle (stiffness ~500, damping ~33) as a CSS curve. */
const SPRING_EASE = 'cubic-bezier(0.22, 1.15, 0.36, 1)';

export function Composer({ session }: { session: SessionMeta }) {
  const isPhone = useIsPhone();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const models = useStore((s) => s.models);
  // Settled total plus the in-flight turn's live estimate, while one runs.
  const liveSpend = useStore((s) => s.turnSpend[session.id]);
  const sessionCost = withLiveSpend(
    session.totalCostUsd,
    liveSpend,
    hasEstimatedSpend(session.costByModel),
  );
  const smartRoutingMode = useStore((s) => s.smartRouting?.mode ?? 'off');
  const projects = useStore((s) => s.projects);
  const connectionStatus = useStore((s) => s.connectionStatus);
  // A guest's grant decides which of these controls exist. All true on your own
  // machine; the bridge refuses anything that slips through regardless.
  const canPrompt = useCan('prompt');
  // On a workflow session the goal is the current step's (the bridge routes it).
  const workflowRunning = !!session.workflow && !isWorkflowFinished(session);
  const stepGoal =
    workflowRunning && session.workflow!.stepGoal?.stepIndex === session.workflow!.stepIndex
      ? session.workflow!.stepGoal
      : undefined;
  const shownGoal = workflowRunning ? stepGoal : session.goal;
  const goalDisabledReason = !canPrompt ? 'Your access does not allow prompting this session.' : null;
  const goalTooltip =
    goalDisabledReason ??
    (shownGoal
      ? 'Edit goal'
      : workflowRunning
        ? 'Set a goal for this step — it keeps working until the goal is met'
        : 'Set a goal — keep going until a condition is met');
  const goalButton = (size: 'lg' | undefined, iconSize: number) => (
    <Tooltip label={goalTooltip}>
      <span style={{ display: 'inline-flex' }}>
        <ActionIcon
          variant={shownGoal ? 'light' : 'subtle'}
          size={size}
          aria-label="Goal"
          disabled={goalDisabledReason !== null}
          onClick={() => setGoalOpen(true)}
        >
          <IconTarget size={iconSize} />
        </ActionIcon>
      </span>
    </Tooltip>
  );
  // The one that actually matters: an accented composer makes typing a prompt
  // into somebody else's machine unaware impossible.
  const remote = useSessionMachine(session.id);
  // This session's own machine, not the one the UI is on: a shared session may be
  // hosted on a laptop that is asleep while the machine in front of you is fine.
  const health = useSessionMachineHealth(session.id);
  const canInterrupt = useCan('interrupt');
  const canSetModel = useCan('setModel');
  const canSetMode = useCan('setPermissionMode');
  const openaiConnected = useStore((s) => s.openaiAuth?.loggedIn === true);
  const claudeCli = useStore((s) => s.claudeCli);
  const codexCli = useStore((s) => s.codexCli);
  /** This session's provider, derived from its model — there is no stored field. */
  const provider: ModelProvider = providerForModel(session.model);
  /** What this session's engine can do. Asked as capabilities rather than as
   *  "is it codex", so a control comes back on its own when the engine gains it. */
  const caps = sessionCaps(session);
  /**
   * The session has a conversation that a provider switch would leave behind.
   * Nothing carries context between a Claude session and a codex thread, so the
   * other provider is not a plain `setModel` any more — it is the confirmed,
   * conversation-dropping `switchProvider` below.
   */
  const hasRun = Boolean(session.claudeSessionId || session.codexThreadId);
  const otherProvider: ModelProvider = provider === 'openai' ? 'anthropic' : 'openai';
  /**
   * Why that switch can't run right now, if it can't — the same predicate the
   * server guards with, so a blocked option explains itself in the dropdown
   * instead of failing silently on click (see modelSelectData's `unavailable`).
   * Only once the session has run: before that a model change is free.
   */
  const switchBlock = hasRun ? providerSwitchBlock(session) : null;
  const modelUnavailable: Partial<Record<ModelProvider, string>> = {
    ...(switchBlock ? { [otherProvider]: switchBlock.reason } : {}),
    ...(openaiConnected || provider === 'openai'
      ? {}
      : { openai: 'Connect an OpenAI account in Settings' }),
  };
  /**
   * A missing engine blocks the model like any other reason, but says so with a
   * warning icon that is a link: it is the one prerequisite the app cannot fix
   * for you, so the row leads to the pane that can. Null on a bridge too old to
   * report it — absent is not "broken".
   *
   * Kept to a few words on purpose: the version, the floor and the install
   * command all live in Settings → Updates, which the icon opens.
   */
  const cliWarning = (status: { state: string } | null, name: string): string | undefined =>
    !status || status.state === 'ok'
      ? undefined
      : status.state === 'missing'
        ? `${name} CLI is not installed on this machine`
        : `${name} CLI on this machine is out of date`;
  const modelWarn: Partial<Record<ModelProvider, string>> = {
    ...(cliWarning(claudeCli, 'Claude Code') ? { anthropic: cliWarning(claudeCli, 'Claude Code')! } : {}),
    ...(cliWarning(codexCli, 'Codex') ? { openai: cliWarning(codexCli, 'Codex')! } : {}),
  };
  /** Opened from a model's warning icon — see describedOptionRenderer. */
  /** Which settings pane that icon (or the mic's warning) opened, if any. */
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  /**
   * The picker's dropdown, controlled only so the warning icon can close it on
   * the way to Settings — otherwise the option list stays open around a modal
   * nobody opened from it.
   *
   * Through `dropdownOpened` + the two callbacks, NOT by handing `Select` a
   * `store` via comboboxProps: Select builds its own store from this prop and
   * drives every interaction through that one, so an injected store only
   * replaces what the dropdown renders with and the picker stops opening.
   */
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  /** A model's display label, falling back to its id for one no longer offered. */
  const modelLabel = (id: string): string => models.find((m) => m.id === id)?.label ?? id;
  /**
   * The step the workflow would take its own model back at, if this session is
   * mid-workflow. Resolved here rather than server-side because the dialog has to
   * say it *before* the switch is sent. Step refs resolve through the same
   * libraries WorkflowStepper reads (useStepResolver).
   */
  const { findWorkflow, lookup: lookupStep } = useStepResolver();
  // An inline snapshot (a guest's own workflow) wins: it is not in any library here.
  const workflowDef = session.workflow
    ? (session.workflow.def ?? findWorkflow(session.workflow.workflowId))
    : undefined;
  const nextStep = workflowDef ? stepAfterProviderSwitch(session, workflowDef, lookupStep) : null;
  /** The model a provider switch is being confirmed for, or null. */
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  /** …and whether that switch has been sent and is still in flight. */
  const [switching, setSwitching] = useState(false);
  const actionError = useStore((s) => s.actionError);
  // The switch is fire-and-forget over the socket and blocks on a summary query
  // for up to a minute with no turn visible, so the dialog holds its loader until
  // the session comes back on the new model — or the server refuses.
  useEffect(() => {
    setSwitching(false);
    setSwitchTo(null);
  }, [session.model, actionError]);
  // Safety net for the one case that clears nothing: the same refusal twice in a
  // row is the same string in the store, so there is no change to react to. The
  // server's own summary bound is a minute; this sits past it.
  useEffect(() => {
    if (!switching) return;
    const timer = setTimeout(() => setSwitching(false), 90_000);
    return () => clearTimeout(timer);
  }, [switching]);
  const needsApproval = useStore((s) => s.access?.caps.promptNeedsApproval === true);
  // Prompt text plus the inline @mention pill ranges painted over it. Seeded from
  // the persisted draft — SessionView is keyed by session id, so this component
  // remounts per session and the lazy initializer is enough to restore.
  const [prompt, setPrompt] = useState(() => readDraft(session.id));
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  // Files picked but still being read or downscaled: shown as spinner tiles, and
  // Send waits for them so ⌘/Enter cannot go out without the image.
  const [pendingFiles, setPendingFiles] = useState<{ id: string; name: string }[]>([]);
  // Staged attachments load from IndexedDB asynchronously (unlike the text
  // draft, which reads synchronously in the initializer above) — this guards
  // the mirror-to-storage effect below from firing with an empty array and
  // wiping the stored attachment draft before the load resolves.
  const attachmentsLoaded = useRef(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionRef = useRef<MentionInputHandle>(null);
  /** Send was pressed while dictating: send once the transcript is spliced in. */
  const sendAfterVoiceRef = useRef(false);
  /** The options that pending Send was pressed with (`queue`). */
  const sendAfterVoiceOptsRef = useRef<{ queue?: boolean } | undefined>(undefined);
  // Splice the transcript in at the caret — then send it, if Send was pressed
  // meanwhile. A failure leaves the prompt exactly as it was and sends nothing.
  const dictation = useVoiceDictation(session.id, (text) => {
    const next = mentionRef.current?.insertText(text) ?? null;
    // Sends the prompt `insertText` returned, not this closure's stale `prompt`.
    if (next && sendAfterVoiceRef.current) sendPrompt(next, sendAfterVoiceOptsRef.current);
  });
  const { voice, voiceError, setVoiceError, voiceLevel } = dictation;
  // However the dictation ended — sent, failed, discarded — a pending Send is spent.
  useEffect(() => {
    if (voice === 'idle') sendAfterVoiceRef.current = false;
  }, [voice]);
  const interruptible = isSessionInterruptible(session.status);
  // A plain send goes into the running turn rather than the queue. A hint for the
  // labels only — the server makes the real call and queues whenever it cannot
  // steer (compaction, a Stop in flight, a closed worker link, …).
  const steers =
    interruptible &&
    session.status === 'running' &&
    caps.interject &&
    !needsApproval &&
    attachments.length === 0 &&
    !session.queued?.length &&
    // A steer the turn settled under: Claude is about to run it as its own turn,
    // so the server queues anything sent now (see canInterject).
    !session.steering?.some((s) => s.afterTurn);
  // Background tasks (backgrounded subagents / Bash) outlive the turn, so a
  // settled session can still have work to stop. Deliberately does not gate Send:
  // the CLI runs a new turn concurrently with a background task.
  const bgTasks = session.backgroundTasks?.length ?? 0;
  const awaitingApproval = session.status === 'waiting-approval';
  // The desktop card's running ring, kept mounted while it fades out.
  const runningFx = useExitDelay(session.status === 'running', 400);

  /**
   * Why this session's machine cannot take a prompt right now, or null.
   *
   * A link that is merely down is not one of those cases: `send` queues prompts
   * and replays them on reconnect, which is the whole point of the offline hint
   * below. The blocking cases are the ones where the socket is fine and the
   * machine behind it is not — the relay drops a frame for a detached bridge in
   * silence, so without this the prompt just disappears.
   */
  const machineBlock = health.connected
    ? linkedMachineHealth({
        bridgeAttached: health.bridgeAttached,
        worker: health.worker,
        storage: health.storage,
      }).block
    : null;

  // "I am looking at this session, and my composer has focus." Debounced inside.
  usePresence(session.id, composerFocused);

  // While dictating, Send finishes the recording and sends with the transcript,
  // so there is always something on its way.
  const nothingToSend = voice === 'idle' && !prompt.text.trim() && attachments.length === 0;
  const preparing = pendingFiles.length > 0;
  const cannotSend = nothingToSend || preparing || machineBlock !== null || !canPrompt;

  // Focus the prompt on a session this tab just created. Keyed on the store's
  // create intent rather than `createdAt`, which is stamped on the bridge machine's
  // clock. On a phone this moves focus off the Sidebar's keyboard primer, so iOS
  // keeps the keyboard it raised inside the tap.
  const focusComposerFor = useStore((s) => s.focusComposerFor);
  const takeComposerFocus = useStore((s) => s.takeComposerFocus);
  useEffect(() => {
    if (focusComposerFor !== session.id) return;
    textareaRef.current?.focus();
    takeComposerFocus();
  }, [focusComposerFor, session.id, takeComposerFocus]);

  // Mirror the draft into localStorage so a reload/restart keeps unsent text.
  useEffect(() => {
    writeDraft(session.id, prompt);
  }, [session.id, prompt]);

  // Restore staged attachments once on mount (SessionView remounts Composer per
  // session via `key`), then mirror every change back to IndexedDB.
  useEffect(() => {
    readDraftAttachments(session.id).then((loaded) => {
      attachmentsLoaded.current = true;
      // Guard the (unlikely) race where the user attaches a file before this
      // load resolves — never clobber attachments already staged in state.
      if (loaded.length) setAttachments((prev) => (prev.length ? prev : loaded));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (attachmentsLoaded.current) void writeDraftAttachments(session.id, attachments);
  }, [session.id, attachments]);

  // A rewind hands the sent prompt back for editing. Subscribed rather than read
  // once on mount: the rewind usually happens in the session already on screen,
  // so this composer is mounted before the reply arrives. Taking it clears it, so
  // the effect's second run (with no prefill) is a no-op.
  //
  // `mentions` is not restored: the stored text is the expanded form, so there
  // are no pill ranges left to paint over it.
  const prefill = useStore((s) => s.composerPrefill[session.id]);
  const takeComposerPrefill = useStore((s) => s.takeComposerPrefill);
  useEffect(() => {
    if (!prefill) return;
    takeComposerPrefill(session.id);
    // A rewind deliberately replaces the draft with the selected prompt.
    setPrompt({ text: prefill.text, ranges: [] });
    setAttachments(prefill.attachments);
    textareaRef.current?.focus();
  }, [prefill, session.id, takeComposerPrefill]);

  useEffect(() => {
    const restore = (event: Event) => {
      const rejected = (event as CustomEvent<Extract<ClientMessage, { type: 'prompt' }>>).detail;
      if (rejected.sessionId !== session.id) return;
      event.preventDefault(); // This mounted composer owns attachment persistence.
      setPrompt((current) => ({
        text: [rejected.text, current.text].filter(Boolean).join('\n\n'),
        ranges: [],
      }));
      setAttachments((current) => [...(rejected.attachments ?? []), ...current]);
    };
    window.addEventListener('lines:prompt-restored', restore);
    return () => window.removeEventListener('lines:prompt-restored', restore);
  }, [session.id]);

  // A Send pressed while dictating went out after its composer unmounted. If this
  // composer remounted on the same session before then, it restored the draft
  // that Send consumed: drop it, unless it has been edited since.
  useEffect(() => {
    const sent = (event: Event) => {
      const { sessionId, text } = (event as CustomEvent<{ sessionId: string; text: string }>).detail;
      if (sessionId !== session.id) return;
      setPrompt((current) => (current.text === text ? { text: '', ranges: [] } : current));
      setAttachments([]);
    };
    window.addEventListener('lines:draft-sent', sent);
    return () => window.removeEventListener('lines:draft-sent', sent);
  }, [session.id]);

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const placeholders = list.map((file) => ({ id: crypto.randomUUID(), name: file.name }));
    setPendingFiles((p) => [...p, ...placeholders]);
    // One at a time, not Promise.all: a phone decoding several 12MP photos at
    // once stalls. Each tile swaps in as soon as its own file is ready.
    for (const [i, file] of list.entries()) {
      const { id } = placeholders[i];
      try {
        const att = await fileToAttachment(file);
        setAttachments((a) => [...a, att]);
      } catch {
        useStore.getState().setActionError(`Couldn't attach ${file.name}.`);
      } finally {
        setPendingFiles((p) => p.filter((f) => f.id !== id));
      }
    }
  };

  const submit = (opts?: { queue?: boolean }) => {
    // Guards ⌘/Enter too, not just the buttons — the keyboard path is the one
    // that would otherwise send into a machine that cannot run it.
    if (cannotSend) return;
    if (voice === 'idle') {
      sendPrompt(prompt, opts);
      return;
    }
    // Dictating: finish first, and let the transcript handler send once the text
    // is in. Already transcribing (the check, or the length limit) needs only the flag.
    sendAfterVoiceRef.current = true;
    sendAfterVoiceOptsRef.current = opts;
    // Leaving the session before the transcript lands must not lose the Send: it
    // goes to this session with the prompt as it stood now, the transcript
    // appended (the caret is gone by then).
    const sessionId = session.id;
    const snapshot = prompt;
    const staged = attachments;
    dictation.commit((text) => {
      const next = spliceTranscript(snapshot, snapshot.text.length, snapshot.text.length, text);
      if (!next) return;
      sendPromptMessage(sessionId, next.value, staged, opts);
      writeDraft(sessionId, { text: '', ranges: [] });
      void writeDraftAttachments(sessionId, []);
      window.dispatchEvent(
        new CustomEvent('lines:draft-sent', { detail: { sessionId, text: snapshot.text } }),
      );
    });
    if (voice === 'recording') void dictation.finish();
  };

  const sendPrompt = (value: MentionValue, opts?: { queue?: boolean }) => {
    sendPromptMessage(session.id, value, attachments, opts);
    setPrompt({ text: '', ranges: [] });
    setAttachments([]);
  };

  const setPermissionMode = (mode: PermissionMode) =>
    send({ type: 'setPermissionMode', sessionId: session.id, mode });

  // Phone twin of the pills: the same three modes, with the description each
  // pill carries in its tooltip spelled out under the label instead.
  const permissionModeMenu = (
    <Menu position="top-start" width={260} withinPortal>
      <Menu.Target>
        <Button
          variant="subtle"
          px={8}
          disabled={!canSetMode || !caps.approvals}
          rightSection={caps.approvals ? <IconChevronDown size={14} /> : undefined}
          aria-label="Permission mode"
        >
          {caps.approvals ? permissionModeLabel(session.permissionMode) : 'Sandboxed'}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {SEGMENT_MODES.map((value) => {
          const mode = PERMISSION_MODES.find((m) => m.value === value)!;
          return (
            <Menu.Item
              key={value}
              onClick={() => setPermissionMode(value)}
              rightSection={value === session.permissionMode ? <IconCheck size={14} /> : undefined}
            >
              <Text size="sm">{mode.label}</Text>
              <Text size="xs" c="dimmed">
                {mode.description}
              </Text>
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );

  const routingOn = smartRoutingMode !== 'off' && session.permissionMode !== 'plan';
  const suggestion = session.routingSuggestion;
  const routingTooltip = session.routingPaused
    ? 'Smart routing is paused for this session. Click to resume.'
    : session.lastRouting
      ? `Smart routing is on. Last change: ${modelLabel(session.lastRouting.model)} · ${
          session.lastRouting.effort ?? 'default'
        } (confidence ${session.lastRouting.confidence.toFixed(2)}). Click to pause.`
      : 'Smart routing is on: each turn may move to another allowed model or effort. Click to pause.';
  const chooseModel = (v: string | null) => {
    if (!v || v === session.model) return;
    // Crossing providers on a session that has run drops its
    // conversation, so it is confirmed rather than dispatched.
    if (hasRun && providerForModel(v) !== provider) {
      setOptionsOpen(false);
      setSwitchTo(v);
      return;
    }
    send({ type: 'setModel', sessionId: session.id, model: v });
  };
  const chooseEffort = (v: string | null) =>
    v &&
    send({
      type: 'setReasoningEffort',
      sessionId: session.id,
      effort: v === AUTO_EFFORT ? null : (v as ReasoningEffort),
    });
  const routingBadge = routingOn && (
    // Smart routing's state for this session; a click pauses or resumes it.
    // A manual model/effort change pauses it on the bridge.
    <Tooltip label={routingTooltip} withArrow openDelay={300} multiline maw={260}>
      <Badge
        size="sm"
        variant={session.routingPaused ? 'outline' : 'light'}
        color={session.routingPaused ? 'gray' : 'violet'}
        style={{ cursor: canSetModel ? 'pointer' : undefined, alignSelf: 'center' }}
        onClick={() =>
          canSetModel &&
          send({ type: 'setRoutingPaused', sessionId: session.id, paused: !session.routingPaused })
        }
      >
        {session.routingPaused ? 'auto off' : 'auto'}
      </Badge>
    </Tooltip>
  );
  const modelControls = (
    <>
      <Select
        w={isPhone ? '100%' : 130}
        label={isPhone ? 'Model' : undefined}
        maw={isPhone ? undefined : 'calc(100vw - 8rem)'}
        disabled={!canSetModel}
        comboboxProps={isPhone ? { withinPortal: false } : modelComboboxProps}
        dropdownOpened={modelDropdownOpen}
        onDropdownOpen={() => setModelDropdownOpen(true)}
        onDropdownClose={() => setModelDropdownOpen(false)}
        // Both providers, with every model this machine or this session cannot
        // take rendered disabled. The reason sits on the models it applies to
        // rather than beside the control, and where the fix is a CLI install
        // the icon opens the pane that carries it.
        data={modelSelectData(models, session.model, {
          unavailable: modelUnavailable,
          warn: modelWarn,
        })}
        renderOption={describedOptionRenderer(() => {
          setModelDropdownOpen(false);
          setOptionsOpen(false);
          setSettingsSection('updates');
        })}
        styles={describedOptionStyles}
        value={session.model}
        onChange={chooseModel}
        allowDeselect={false}
      />
      {/* Disabled rather than hidden on an engine with no effort control, for
              the same reason the permission segments above are, and inside a span
              so the tooltip fires over it. */}
      <Tooltip
        label={
          caps.reasoningEfforts.length
            ? 'How hard the model thinks. Takes effect on the next turn.'
            : 'This engine does not expose a reasoning-effort control.'
        }
        withArrow
        openDelay={400}
      >
        <span
          style={{
            display: 'inline-flex',
            width: isPhone ? '100%' : undefined,
          }}
        >
          <Select
            w={isPhone ? '100%' : 120}
            label={isPhone ? 'Reasoning effort' : undefined}
            maw={isPhone ? undefined : 'calc(100vw - 8rem)'}
            disabled={!canSetModel || caps.reasoningEfforts.length === 0}
            comboboxProps={isPhone ? { withinPortal: false } : modelComboboxProps}
            data={effortSelectData(caps.reasoningEfforts, session.reasoningEffort)}
            renderOption={renderOptionWithDescription}
            value={session.reasoningEffort ?? AUTO_EFFORT}
            onChange={chooseEffort}
            allowDeselect={false}
          />
        </span>
      </Tooltip>
      {routingBadge}
    </>
  );
  const stopWork = () =>
    send(
      interruptible
        ? { type: 'interrupt', sessionId: session.id }
        : { type: 'stopBackgroundTasks', sessionId: session.id },
    );

  const borderColor = dragging
    ? 'var(--mantine-primary-color-filled)'
    : remote.isRemote
      ? 'var(--mantine-color-grape-5)'
      : undefined;
  const dropHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
    },
  };

  // Desktop toolbar pieces.
  const modelData = modelSelectData(models, session.model, {
    unavailable: modelUnavailable,
    warn: modelWarn,
  });
  const effortData = effortSelectData(caps.reasoningEfforts, session.reasoningEffort);
  const effortValue = session.reasoningEffort ?? AUTO_EFFORT;
  const effortLabel = effortData.find((e) => e.value === effortValue)?.label ?? effortValue;
  const openUpdates = () => {
    setModelDropdownOpen(false);
    setSettingsSection('updates');
  };
  const modeSwitch = (
    <div className={styles.modes} role="radiogroup" aria-label="Permission mode">
      {SEGMENT_MODES.map((value) => {
        const mode = PERMISSION_MODES.find((m) => m.value === value)!;
        const active = session.permissionMode === value;
        return (
          <Tooltip key={value} label={mode.description} withArrow disabled={!caps.approvals}>
            <UnstyledButton
              className={styles.mode}
              role="radio"
              aria-checked={active}
              data-active={active || undefined}
              data-mode={value}
              disabled={!canSetMode || !caps.approvals}
              onClick={() => !active && setPermissionMode(value)}
            >
              {mode.label}
            </UnstyledButton>
          </Tooltip>
        );
      })}
    </div>
  );
  const modelMenu = (
    <Menu
      position="top-start"
      offset={10}
      width="max-content"
      opened={modelDropdownOpen}
      onChange={setModelDropdownOpen}
      transitionProps={{ transition: MENU_TRANSITION, duration: 240, timingFunction: SPRING_EASE }}
      classNames={{
        dropdown: `${styles.palette} ${styles.menu} ${styles.modelMenu}`,
        label: styles.menuLabel,
        item: styles.menuItem,
      }}
    >
      <Menu.Target>
        <UnstyledButton className={styles.picker} disabled={!canSetModel} aria-label="Model">
          {modelLabel(session.model)}
          <IconChevronDown size={12} />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Model</Menu.Label>
        {modelData.map((item) => (
          <Menu.Item
            key={item.value}
            data-unavailable={item.disabled || undefined}
            aria-disabled={item.disabled || undefined}
            closeMenuOnClick={!item.disabled}
            onClick={() => {
              // Unavailable rows stay clickable only so their warning can lead
              // to the pane that fixes it, as the Select's renderer did.
              if (item.disabled) {
                if (item.warningActionable) openUpdates();
                return;
              }
              chooseModel(item.value);
            }}
          >
            <div className={styles.menuRow}>
              <span className={styles.menuItemLabel}>
                {item.label}
                {item.warning && (
                  <Tooltip
                    label={item.warningActionable ? `${item.warning} — open Updates` : item.warning}
                    withArrow
                    multiline
                    w={240}
                    position="right"
                  >
                    <ThemeIcon size={14} radius="xl" color="orange" variant="filled">
                      <IconAlertTriangle size={10} />
                    </ThemeIcon>
                  </Tooltip>
                )}
              </span>
              {item.description && <span className={styles.menuItemHint}>{item.description}</span>}
            </div>
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
  const effortMenu = (
    <Menu
      position="top-start"
      offset={10}
      width={174}
      transitionProps={{ transition: MENU_TRANSITION, duration: 240, timingFunction: SPRING_EASE }}
      classNames={{
        dropdown: `${styles.palette} ${styles.menu}`,
        label: styles.menuLabel,
        item: styles.menuItem,
      }}
    >
      <Menu.Target>
        {/* Disabled rather than hidden on an engine with no effort control, in
            a span so the tooltip still fires over it. */}
        <span className={styles.anchor}>
          <Tooltip
            label={
              caps.reasoningEfforts.length
                ? 'How hard the model thinks. Takes effect on the next turn.'
                : 'This engine does not expose a reasoning-effort control.'
            }
            withArrow
            openDelay={400}
          >
            <UnstyledButton
              className={styles.picker}
              disabled={!canSetModel || caps.reasoningEfforts.length === 0}
              aria-label="Reasoning effort"
            >
              {effortLabel} effort
              <IconChevronDown size={12} />
            </UnstyledButton>
          </Tooltip>
        </span>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Effort</Menu.Label>
        {effortData.map((item) => (
          <Menu.Item
            key={item.value}
            disabled={item.disabled}
            data-unavailable={item.disabled || undefined}
            onClick={() => item.value !== effortValue && chooseEffort(item.value)}
          >
            <div className={styles.menuRow}>
              <span className={styles.menuItemLabel}>{item.label}</span>
            </div>
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
  const onMic = () => {
    if (dictation.voiceBlock) {
      if (dictation.voiceBlockActionable) setSettingsSection('voice');
      else setVoiceError(dictation.voiceBlock);
      return;
    }
    void (voice === 'recording' ? dictation.finish() : dictation.start());
  };
  const micLabel = dictation.voiceBlock
    ? dictation.voiceBlockActionable
      ? `${dictation.voiceBlock} — open Voice input settings`
      : dictation.voiceBlock
    : voice === 'recording'
      ? 'Finish and transcribe'
      : voice === 'transcribing'
        ? 'Transcribing…'
        : 'Dictate';
  const dictateControl = (
    <Popover
      opened={voice === 'recording'}
      position="top-end"
      offset={8}
      width={330}
      withArrow
      arrowSize={13}
      arrowOffset={10}
      transitionProps={{ transition: POPOVER_TRANSITION, duration: 260, timingFunction: SPRING_EASE }}
      classNames={{
        dropdown: `${styles.palette} ${styles.popover}`,
        arrow: styles.popoverArrow,
      }}
    >
      <Popover.Target>
        <div className={styles.anchor}>
          <Tooltip label={micLabel} withArrow multiline maw={260} disabled={voice === 'recording'}>
            <UnstyledButton
              className={styles.iconButton}
              data-active={voice === 'recording' || undefined}
              aria-label={dictation.voiceBlock ?? micLabel}
              aria-disabled={dictation.voiceBlock !== null || undefined}
              disabled={voice === 'transcribing'}
              onClick={onMic}
            >
              {voice === 'transcribing' ? (
                <Loader size={14} color="gray" />
              ) : (
                <IconMicrophone size={16} opacity={dictation.voiceBlock ? 0.5 : 1} />
              )}
            </UnstyledButton>
          </Tooltip>
        </div>
      </Popover.Target>
      <Popover.Dropdown p={14}>
        <div className={styles.dictation}>
          <div className={styles.dictationHeader}>
            <div className={styles.dictationTitle}>
              <span className={styles.recordingDot} aria-hidden />
              <IconMicrophone size={14} />
              <span>Listening</span>
            </div>
            <span className={styles.dictationTimer}>
              {formatElapsed(dictation.elapsed)} / {formatElapsed(dictation.limitSeconds * 1000)}
            </span>
          </div>
          <div className={styles.waveform}>
            <div className={styles.waveformTrack}>
              {voiceLevel && <VoiceWaveform level={voiceLevel} height={32} />}
            </div>
          </div>
          <div className={styles.dictationText}>
            {/* Near the limit the hint gives way to the countdown and its "+2 min". */}
            {dictation.remainingMs !== null ? (
              <VoiceLimitNotice dictation={dictation} keepFocus />
            ) : (
              'Insert text transcribes what you say.'
            )}
          </div>
          <div className={styles.actions}>
            <UnstyledButton
              className={styles.ghostButton}
              onMouseDown={(e) => e.preventDefault()}
              onClick={dictation.cancel}
            >
              <IconX size={13} />
              Cancel
            </UnstyledButton>
            <UnstyledButton
              className={styles.primaryButton}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void dictation.finish()}
            >
              <IconCheck size={13} />
              Insert text
            </UnstyledButton>
          </div>
        </div>
      </Popover.Dropdown>
    </Popover>
  );
  const sendLabel = awaitingApproval
    ? "Send — keeps iterating on this step (won't advance the workflow)"
    : bgTasks > 0
      ? 'Send — the background task keeps running'
      : 'Send message';
  const stopLabel = !interruptible
    ? 'Stop background work'
    : session.workflow?.started &&
        session.workflow.stepStatuses[session.workflow.stepIndex] === 'running'
      ? 'Stop — the step will wait for your review'
      : 'Interrupt';
  const showCost =
    sessionCost.usd != null &&
    (!caps.contextWindow || (!session.contextSummary && !session.contextUsage));

  const body = (
    <>
      {dragging && (
        <Stack
          align="center"
          justify="center"
          gap={4}
          style={{
            position: 'absolute',
            inset: 4,
            zIndex: 3,
            borderRadius: 'var(--mantine-radius-md)',
            border: '2px dashed var(--mantine-primary-color-filled)',
            background: 'var(--mantine-color-body)',
            opacity: 0.97,
            pointerEvents: 'none',
          }}
        >
          <IconUpload size={26} opacity={0.7} />
          <Text size="sm" c="dimmed">
            Drop files to attach
          </Text>
        </Stack>
      )}
      {shownGoal && (
        <GoalChip
          goal={shownGoal}
          stepIndex={stepGoal?.stepIndex}
          canEdit={canPrompt}
          onEdit={() => setGoalOpen(true)}
          onClear={() => send({ type: 'clearGoal', sessionId: session.id })}
        />
      )}
      {!isPhone && (attachments.length > 0 || pendingFiles.length > 0) && (
        <div className={styles.attachments}>
          {attachments.map((att, i) => (
            <AttachmentChip
              key={i}
              att={att}
              onOpen={() => setLightbox(`data:${att.mediaType};base64,${att.data}`)}
              onRemove={() => setAttachments((a) => a.filter((_, j) => j !== i))}
            />
          ))}
          {pendingFiles.map((f) => (
            <div key={f.id} className={styles.file} aria-label={`Preparing ${f.name}`}>
              <div className={styles.fileThumb}>
                <Loader size={14} color="gray" />
              </div>
              <div className={styles.fileMeta}>
                <div className={styles.fileName} title={f.name}>
                  {f.name}
                </div>
                <div className={styles.fileSize}>Preparing…</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {isPhone && (attachments.length > 0 || pendingFiles.length > 0) && (
        <Group gap="xs" px={6} pb={6}>
          {attachments.map((att, i) => (
            <PreviewTile
              key={i}
              att={att}
              onOpen={() => setLightbox(`data:${att.mediaType};base64,${att.data}`)}
              onRemove={() => setAttachments((a) => a.filter((_, j) => j !== i))}
            />
          ))}
          {pendingFiles.map((f) => (
            <Tooltip key={f.id} label={`Preparing ${f.name}…`}>
              <Paper
                withBorder
                radius="md"
                aria-label={`Preparing ${f.name}`}
                style={{
                  width: 64,
                  height: 64,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Loader size="sm" />
              </Paper>
            </Tooltip>
          ))}
          {preparing && (
            <Text size="xs" c="dimmed">
              Preparing image…
            </Text>
          )}
        </Group>
      )}
      {suggestion && (
        // Ask-mode routing: the turn is held on the bridge until one of these.
        <Paper withBorder radius="md" p="xs" mx={6} mb={6}>
          <Group justify="space-between" gap="xs" wrap="nowrap">
            <Text size="sm">
              JEV suggests {modelLabel(suggestion.model)} · {suggestion.effort ?? 'default'} (
              {suggestion.confidence.toFixed(2)})
            </Text>
            <Group gap={6} wrap="nowrap">
              <Button
                size="compact-xs"
                disabled={!canSetModel}
                onClick={() => send({ type: 'routingChoice', sessionId: session.id, accept: true })}
              >
                Switch &amp; send
              </Button>
              <Button
                size="compact-xs"
                variant="default"
                disabled={!canSetModel}
                onClick={() => send({ type: 'routingChoice', sessionId: session.id, accept: false })}
              >
                Send as is
              </Button>
            </Group>
          </Group>
        </Paper>
      )}
      {connectionStatus !== 'connected' && (
        <Text size="xs" c="dimmed" px={6} pb={6}>
          Reconnecting — messages are queued and sent once connected
        </Text>
      )}
      {!canPrompt && (
        <Text size="xs" c="dimmed" px={6} pb={6}>
          You have view-only access to this session.
        </Text>
      )}
      {canPrompt && needsApproval && (
        // Said before sending, not after: a prompt that silently waits for
        // somebody else to release it reads as a broken send.
        <Text size="xs" c="dimmed" px={6} pb={6}>
          Your prompts wait for the owner to release them.
        </Text>
      )}
      {machineBlock && (
        // Named, not dimmed: this is why the send button is dead, and the
        // alternative is a prompt that looks sent and never runs. Deliberately not
        // a banner — ConnectionBanner/WorkerBanner/UpdateBanner keep their own
        // "exactly one at a time" precedence, and machine health belongs on the
        // surface you are about to type into.
        <Text size="xs" c="orange" px={6} pb={6}>
          {machineBlock}
        </Text>
      )}
      {voiceError && (
        // Click to dismiss, like the sidebar's action error: a notice about one
        // dictation, not a state.
        <Text size="xs" c="red" px={6} pb={6} onClick={() => setVoiceError(null)} style={{ cursor: 'pointer' }}>
          {voiceError}
        </Text>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.currentTarget.files) void addFiles(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
      {/* Positioned so the recording overlay can sit exactly over the input,
          which stays mounted underneath — its caret is where the text lands. */}
      <Box style={{ position: 'relative' }}>
        <MentionInput
          value={prompt}
          onChange={setPrompt}
          onSubmit={submit}
          cwd={session.cwd}
          roots={rootsForCwd(projects, session.cwd)}
          placeholder={
            session.workflow && !session.workflow.started
              ? 'Describe the task — this kicks off the workflow…'
              : `Message ${provider === 'openai' ? 'Codex' : 'Claude'}…${
                  isPhone ? '' : ` (↵ to send, ⇧↵ for newline${steers ? ', ⌥↵ to queue' : ''})`
                }`
          }
          textareaRef={textareaRef}
          handleRef={mentionRef}
          minRows={isPhone ? 1 : 2}
          onFocusChange={setComposerFocused}
          onPasteFiles={(files) => void addFiles(files)}
        />
        {isPhone && voice === 'recording' && voiceLevel && (
          // ChatGPT-style: while recording, the input *is* the waveform. A Paper
          // so it takes the composer's own background, whatever the theme. On a
          // desktop the mic's own popover carries the recording instead.
          <Paper
            style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex', alignItems: 'center' }}
            px={4}
          >
            <Group gap="xs" wrap="nowrap" w="100%">
              <Box style={{ flex: 1, minWidth: 0 }} c="dimmed">
                <VoiceWaveform level={voiceLevel} height={isPhone ? 24 : 32} />
              </Box>
              {/* Near the limit the timer gives way to the countdown and its
                  "+2 min"; pressing it must not take focus off the textarea. */}
              {dictation.remainingMs !== null ? (
                <VoiceLimitNotice dictation={dictation} keepFocus />
              ) : (
                <Text size="xs" c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatElapsed(dictation.elapsed)}
                </Text>
              )}
            </Group>
          </Paper>
        )}
      </Box>
      {isPhone ? (
        <Group justify="space-between" gap={4} wrap="nowrap" pt={4} className="lines-safe-bottom">
          <Group gap={4} wrap="nowrap">
            <ActionIcon
              variant="subtle"
              aria-label="Attach files"
              onClick={() => fileInputRef.current?.click()}
            >
              <IconPaperclip size={18} />
            </ActionIcon>
            {/* The mode is the one setting worth knowing before you send, so it
                is its own dropdown; the rarer model/context settings sit behind
                a separate Options sheet. */}
            {permissionModeMenu}
            <ActionIcon variant="subtle" aria-label="Options" onClick={() => setOptionsOpen(true)}>
              <IconAdjustmentsHorizontal size={18} />
            </ActionIcon>
            {goalButton(undefined, 18)}
          </Group>
          <Group gap={4} wrap="nowrap">
            {/* Beside Send, where a mic is expected to be: dictating is the
                other way of writing the message that button sends. */}
            {canPrompt && (
              <DictateButton dictation={dictation} iconSize={18} onBlockedClick={() => setSettingsSection('voice')} />
            )}
            {(interruptible || bgTasks > 0) && (
              <Button
                variant="default"
                px={8}
                disabled={!canInterrupt}
                onClick={stopWork}
                aria-label={interruptible ? 'Stop current turn' : 'Stop background work'}
              >
                Stop
              </Button>
            )}
            {steers && (
              <ActionIcon
                variant="default"
                size="lg"
                disabled={cannotSend}
                aria-label="Queue message"
                onClick={() => submit({ queue: true })}
              >
                <IconClock size={18} />
              </ActionIcon>
            )}
            <Button px={10} disabled={cannotSend} onClick={() => submit()}>
              {interruptible && !steers ? 'Queue' : 'Send'}
            </Button>
          </Group>
        </Group>
      ) : (
        // `wrap`: a narrow window must not clip the send button off the row.
        <div className={`${styles.toolbar} lines-safe-bottom`}>
          <div className={styles.tools}>
            <Tooltip label="Attach files">
              <UnstyledButton
                className={styles.iconButton}
                aria-label="Attach files"
                onClick={() => fileInputRef.current?.click()}
              >
                <IconPaperclip size={16} />
              </UnstyledButton>
            </Tooltip>
            <Tooltip label={goalTooltip}>
              <span className={styles.anchor}>
                <UnstyledButton
                  className={styles.iconButton}
                  data-active={shownGoal ? true : undefined}
                  aria-label="Goal"
                  disabled={goalDisabledReason !== null}
                  onClick={() => setGoalOpen(true)}
                >
                  <IconTarget size={16} />
                </UnstyledButton>
              </span>
            </Tooltip>
            <div className={styles.divider} />
            {/* Visible but disabled for a codex session, deliberately: its absence
                would read as a bug, and the tooltip is where the reduced surface
                gets explained. Only wrapped in that disabled state — each mode
                carries its own description tooltip otherwise. */}
            {caps.approvals ? (
              modeSwitch
            ) : (
              <Tooltip
                label={
                  'This session runs sandboxed and approves its own tool calls. ' +
                  'Plan mode is read-only here, and your MCP connections do not apply.'
                }
                withArrow
                openDelay={400}
              >
                <span className={styles.anchor}>{modeSwitch}</span>
              </Tooltip>
            )}
            {modelMenu}
            {effortMenu}
            {routingBadge}
          </div>
          <div className={styles.tools}>
            <ContextWindowIndicator session={session} />
            {showCost && (
              <span className={styles.cost}>{formatSpendUsd(sessionCost.usd!, sessionCost.estimated)}</span>
            )}
            {canPrompt && dictateControl}
            {/* Running, Send gives way to Stop; it comes back beside Stop once
                there is something to steer in (or queue, ⌥↵). */}
            {(!interruptible || !nothingToSend) && (
              <Tooltip
                label={
                  interruptible
                    ? steers
                      ? 'Send into the current turn — ⌥↵ to queue for after'
                      : 'Queue message — sends after the current turn'
                    : sendLabel
                }
              >
                <UnstyledButton
                  className={styles.send}
                  data-ready={!cannotSend || undefined}
                  aria-label={interruptible && !steers ? 'Queue message' : 'Send message'}
                  onClick={() => submit()}
                  disabled={cannotSend}
                >
                  <IconSend size={16} />
                </UnstyledButton>
              </Tooltip>
            )}
            {(interruptible || bgTasks > 0) && (
              <Tooltip label={stopLabel}>
                <UnstyledButton
                  className={styles.stop}
                  disabled={!canInterrupt}
                  aria-label="Stop work"
                  onClick={stopWork}
                >
                  <span className={styles.stopSquare} />
                </UnstyledButton>
              </Tooltip>
            )}
          </div>
        </div>
      )}
      {/* Sized by its content, not by a share of the screen: a sheet pinned at
          80dvh is the same height whether it holds four controls or one, and
          four controls do not fill a phone. The top padding on
          `.lines-mobile-sheet-inner` is what stops a long one running off the top. */}
      <Drawer
        opened={isPhone && optionsOpen}
        onClose={() => setOptionsOpen(false)}
        position="bottom"
        size="auto"
        padding="sm"
        title="Options"
        classNames={{
          content: 'lines-mobile-sheet',
          inner: 'lines-mobile-sheet-inner',
        }}
      >
        <Stack gap="sm" className="lines-safe-bottom">
          {/* The mode itself lives in its own dropdown on the row; only the
              sandbox caption stays, since a disabled "Sandboxed" chip cannot
              explain itself. */}
          {!caps.approvals && (
            <Text size="xs" c="dimmed">
              Sandboxed: this session approves its own tool calls. Plan mode is read-only, and your MCP connections do not apply.
            </Text>
          )}
          {modelControls}
          {!canSetModel && (
            <Text size="xs" c="dimmed">
              Your access does not allow changing the model or reasoning effort.
            </Text>
          )}
          {caps.reasoningEfforts.length === 0 && (
            <Text size="xs" c="dimmed">
              This engine does not expose a reasoning-effort control.
            </Text>
          )}
          {[...new Set([...Object.values(modelUnavailable), ...Object.values(modelWarn)])].map(
            (reason) => (
              <Text key={reason} size="xs" c="dimmed">
                {reason}
              </Text>
            ),
          )}
          <ContextWindowIndicator session={session} inline />
          {sessionCost.usd != null &&
            (!caps.contextWindow || (!session.contextSummary && !session.contextUsage)) && (
              <Text size="xs" c="dimmed">
                Session cost {formatSpendUsd(sessionCost.usd, sessionCost.estimated)}
              </Text>
            )}
        </Stack>
      </Drawer>
      {/* Opened only from a model's or the mic's warning icon — the pane that carries the
          version, the floor and the install command. Rendered here, exactly as
          SyncIndicator opens its own copy at Diagnostics. */}
      <GoalModal session={session} opened={goalOpen} onClose={() => setGoalOpen(false)} />
      <SettingsModal
        opened={settingsSection !== null}
        onClose={() => setSettingsSection(null)}
        initialSection={settingsSection ?? 'updates'}
      />
      <ConfirmModal
        opened={switchTo !== null}
        title="Switch provider?"
        message={
          [
            `This session has been running on ${agentLabel(session)}. ` +
              `Moving it to ${modelLabel(switchTo ?? '')} starts a brand-new conversation: ` +
              'everything said so far is dropped, and a summary of it is sent as the first ' +
              'message instead. The transcript here is kept — but the summary is lossy, so ' +
              'anything it misses is gone from the new model’s view.',
            // Named before the click, because it is not undone afterwards.
            interruptible ? 'The turn running now is stopped first.' : '',
            nextStep
              ? `Step ${nextStep.index + 1} takes the workflow’s own model back` +
                (nextStep.model ? ` (${modelLabel(nextStep.model)})` : '') +
                '.' +
                // Only when the switch actually changes what that step does: a step
                // already set to start fresh would have done this anyway.
                (nextStep.inherits
                  ? ' It continues this conversation, so it will start fresh from the ' +
                    'previous step’s output instead.'
                  : '')
              : '',
          ]
            .filter(Boolean)
            .join(' ')
        }
        confirmLabel="Switch and summarize"
        confirmLoading={switching}
        onConfirm={() => {
          if (!switchTo) return;
          setSwitching(true);
          send({
            type: 'switchProvider',
            sessionId: session.id,
            model: switchTo,
          });
        }}
        onCancel={() => setSwitchTo(null)}
      />
      <Modal
        opened={lightbox !== null}
        onClose={() => setLightbox(null)}
        withCloseButton={false}
        centered
        padding={0}
        size="auto"
        styles={{ content: { background: 'transparent', boxShadow: 'none' } }}
      >
        {lightbox && (
          <img
            src={lightbox}
            alt=""
            style={{
              maxWidth: '90vw',
              maxHeight: 'calc(var(--lines-viewport) - var(--lines-safe-top) - 2rem)',
              display: 'block',
              borderRadius: 8,
            }}
          />
        )}
      </Modal>
    </>
  );

  if (isPhone) {
    return (
      // On a phone the composer is a strip across the bottom rather than a card:
      // no corners, no side or bottom border, no margin. The footer row's
      // `lines-safe-bottom` still keeps Send above the home indicator.
      <Paper
        withBorder
        radius={0}
        p="xs"
        pb={0}
        m={0}
        maw={920}
        w="100%"
        style={{
          position: 'relative',
          borderLeft: 'none',
          borderRight: 'none',
          borderBottom: 'none',
          borderColor,
        }}
        {...dropHandlers}
      >
        {body}
      </Paper>
    );
  }

  return (
    <div className={`${styles.palette} ${styles.root}`}>
      <div className={styles.wrap}>
        {runningFx !== 'hidden' && (
          <>
            <div className={styles.halo} data-exiting={runningFx === 'exiting' || undefined} aria-hidden>
              <div className={`${styles.spinner} ${styles.haloSpinner}`} />
            </div>
            <div className={styles.ring} data-exiting={runningFx === 'exiting' || undefined} aria-hidden>
              <div className={`${styles.spinner} ${styles.ringSpinner}`} />
            </div>
          </>
        )}
        <div
          className={styles.card}
          data-mode={session.permissionMode}
          data-running={session.status === 'running' || undefined}
          style={{ borderColor }}
          {...dropHandlers}
        >
          <div className={styles.edge} aria-hidden />
          {body}
        </div>
      </div>
    </div>
  );
}
