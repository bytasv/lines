import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Drawer,
  Group,
  Menu,
  Modal,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useHover } from '@mantine/hooks';
import {
  IconAdjustmentsHorizontal,
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconFile,
  IconMicrophone,
  IconPaperclip,
  IconPlayerStop,
  IconSend,
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
  VOICE_LANGUAGES,
  voiceModelReady,
  whisperModelFor,
} from '@lines/shared';
import { formatSpendUsd, stepAfterProviderSwitch } from '../lib/format';
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
  PERMISSION_MODE_SEGMENTS,
  SEGMENT_MODES,
} from '../lib/permissionModes';
import { buildExpandedPrompt, uniqueMentions } from '../lib/mentions';
import { linkedMachineHealth } from '../lib/machineHealth';
import { useCan, useSessionMachine, useSessionMachineHealth } from '../lib/can';
import { usePresence } from '../lib/presence';
import { ConfirmModal } from './ConfirmModal';
import { ContextWindowIndicator } from './ContextWindowIndicator';
import { SettingsModal, type SettingsSection } from './SettingsModal';
import { MentionInput, type MentionInputHandle } from './MentionInput';
import { VoiceWaveform } from './VoiceWaveform';
import { send, transcribeAudio } from '../ws';
import { startVoiceRecording, voiceInputSupported, type VoiceRecording } from '../lib/voiceRecorder';
import { useIsPhone } from '../lib/layout';

/** Read a File into a raw-base64 PromptAttachment (strips the data: URI prefix). */
export function fileToAttachment(file: File): Promise<PromptAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve({
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        data: result.slice(result.indexOf(',') + 1),
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** What went wrong asking for the mic, in words — the DOMException names are not. */
function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was refused.';
  if (name === 'NotFoundError') return 'No microphone was found.';
  return err instanceof Error ? err.message : 'Could not start the microphone.';
}

/** `m:ss`, for the recording timer. */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
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

export function Composer({ session }: { session: SessionMeta }) {
  const isPhone = useIsPhone();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const models = useStore((s) => s.models);
  const smartRoutingMode = useStore((s) => s.smartRouting?.mode ?? 'off');
  const projects = useStore((s) => s.projects);
  const connectionStatus = useStore((s) => s.connectionStatus);
  const queuedCount = useStore(
    (s) => s.queuedPrompts.filter((q) => q.sessionId === session.id).length,
  );
  // A guest's grant decides which of these controls exist. All true on your own
  // machine; the bridge refuses anything that slips through regardless.
  const canPrompt = useCan('prompt');
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
   * say it *before* the switch is sent. Step refs resolve through the same three
   * libraries WorkflowStepper's `nameOf` reads.
   */
  const workflows = useStore((s) => s.workflows);
  const pinnedSteps = useStore((s) => s.pinnedSteps);
  const sharedSteps = useStore((s) => s.sharedSteps);
  const libSteps = useStore((s) => s.steps);
  const workflowDef = session.workflow
    ? workflows.find((w) => w.id === session.workflow!.workflowId)
    : undefined;
  const nextStep = workflowDef
    ? stepAfterProviderSwitch(session, workflowDef, (ownerId, stepId, version) => {
        const all = [...pinnedSteps, ...libSteps, ...sharedSteps];
        return (
          all.find((d) => d.ownerId === ownerId && d.id === stepId && d.version === version) ??
          all.find((d) => d.ownerId === ownerId && d.id === stepId)
        );
      })
    : null;
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
  /**
   * Voice input's transcriber is the *session's* machine's, not the one the UI is
   * pointed at: a shared session's audio goes to its host, so the mic follows the
   * host's install. The global copy only for a session whose machine is unknown.
   */
  const whisper = useStore((s) => {
    const slice = remote.deviceId !== null ? s.machines[remote.deviceId] : undefined;
    return slice ? slice.whisper : s.whisper;
  });
  const [voice, setVoice] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [voiceStartedAt, setVoiceStartedAt] = useState(0);
  const [voiceElapsed, setVoiceElapsed] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recordingRef = useRef<VoiceRecording | null>(null);
  /** The warning dot only shows on hover: a mic that is never set up would
   *  otherwise wear an orange badge in every composer, forever. */
  const [micHovered, setMicHovered] = useState(false);
  const ownMachine = useStore((s) => (s.access?.scope ?? 'owner') === 'owner') && !remote.isRemote;
  const where = ownMachine ? 'this machine' : 'the host’s machine';
  // The user's own choice, even on somebody else's machine: it is their speech.
  const voiceLanguage = useStore((s) => s.voiceLanguage);
  const voiceTranslate = useStore((s) => s.voiceTranslate);
  const voiceLanguageLabel = VOICE_LANGUAGES.find((l) => l.code === voiceLanguage)?.label ?? voiceLanguage;
  const voiceModel = whisperModelFor(voiceLanguage);
  /**
   * Why the mic cannot record, or null. Rendered rather than hidden, like a model
   * whose CLI is missing: an absent button reads as "this app has no voice
   * input", a disabled one with a reason says what to install. Ignored once a
   * recording has started, so a status flip mid-recording cannot strand it.
   */
  const voiceBlock =
    voice !== 'idle'
      ? null
      : !voiceInputSupported()
        ? 'Voice input needs a secure (https) page'
        : !whisper
          ? 'This bridge does not report voice input'
          : whisper.state === 'missing-binary'
            ? `Voice input needs whisper.cpp on ${where}`
            : whisper.state === 'outdated'
              ? `whisper.cpp on ${where} is out of date`
              : !voiceModelReady(whisper.models ?? [], voiceLanguage)
                ? `${voiceLanguage === 'auto' ? 'Voice input' : `Dictating in ${voiceLanguageLabel}`} needs a one-time ` +
                  `model download (${voiceModel.sizeLabel}) on ${where}`
                : null;
  /** Settings → Voice input carries the install command and the model download —
   *  but only for your own machine; a guest's copy of Settings has no such pane,
   *  and it would describe the wrong computer anyway. */
  const voiceBlockActionable = voiceBlock !== null && ownMachine && voiceInputSupported();
  const interruptible = isSessionInterruptible(session.status);
  // Background tasks (backgrounded subagents / Bash) outlive the turn, so a
  // settled session can still have work to stop. Deliberately does not gate Send:
  // the CLI runs a new turn concurrently with a background task.
  const bgTasks = session.backgroundTasks?.length ?? 0;
  const awaitingApproval = session.status === 'waiting-approval';

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

  const nothingToSend = !prompt.text.trim() && attachments.length === 0;
  const cannotSend = nothingToSend || machineBlock !== null || !canPrompt;

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

  // The recording timer, and letting go of the mic if the composer unmounts
  // mid-recording (switching sessions remounts it).
  useEffect(() => {
    if (voice !== 'recording') return;
    const timer = setInterval(() => setVoiceElapsed(Date.now() - voiceStartedAt), 250);
    return () => clearInterval(timer);
  }, [voice, voiceStartedAt]);
  useEffect(() => () => recordingRef.current?.cancel(), []);
  /** The live recording's loudness probe, for the waveform. In state rather than
   *  read off the ref so the overlay re-renders when a recording starts. */
  const [voiceLevel, setVoiceLevel] = useState<(() => number) | null>(null);

  /** Throw the recording away: the X in the waveform overlay. */
  const cancelVoice = () => {
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setVoiceLevel(null);
    setVoice('idle');
  };

  /** Stop, transcribe on the session's machine, and splice the text in at the
   *  caret. A failure leaves the prompt exactly as it was. */
  const finishVoice = async () => {
    const recording = recordingRef.current;
    if (!recording) return;
    recordingRef.current = null;
    setVoiceLevel(null);
    setVoice('transcribing');
    try {
      const audio = await recording.stop();
      const text = await transcribeAudio(
        audio,
        { language: voiceLanguage, translate: voiceTranslate },
        remote.deviceId ?? undefined,
      );
      if (text) mentionRef.current?.insertText(text);
      else setVoiceError('Nothing was heard in that recording.');
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : 'Transcription failed.');
    } finally {
      setVoice('idle');
    }
  };

  const startVoice = async () => {
    setVoiceError(null);
    try {
      // The limit stops capture on its own; transcribing what was caught is the
      // least surprising thing to do with it.
      const recording = await startVoiceRecording({ onLimit: () => void finishVoice() });
      recordingRef.current = recording;
      setVoiceLevel(() => recording.level);
      setVoiceStartedAt(Date.now());
      setVoiceElapsed(0);
      setVoice('recording');
    } catch (err) {
      setVoiceError(micErrorMessage(err));
    }
  };

  const micControl = (iconSize: number, size?: string) =>
    canPrompt && (
      <Group gap={4} wrap="nowrap">
        {/* Beside the check, not in the overlay: finish and discard are one
            decision, so they sit together under the same thumb. */}
        {voice === 'recording' && (
          <Tooltip label="Discard recording">
            <ActionIcon variant="subtle" color="gray" size={size} aria-label="Discard recording" onClick={cancelVoice}>
              <IconX size={iconSize} />
            </ActionIcon>
          </Tooltip>
        )}
        <Tooltip
          label={
            voiceBlock
              ? voiceBlockActionable
                ? `${voiceBlock} — open Voice input settings`
                : voiceBlock
              : voice === 'recording'
                ? 'Finish and transcribe'
                : voice === 'transcribing'
                  ? 'Transcribing…'
                  : 'Dictate'
          }
          withArrow
          multiline
          maw={260}
        >
          {/* Dimmed, not `disabled`: a disabled ActionIcon swallows the click
              that opens Updates. The warning dot is the model picker's. */}
          <ActionIcon
            // Recording: a filled check, the "done" half of the overlay's X.
            variant={voice === 'recording' ? 'filled' : 'subtle'}
            color={voiceBlock ? 'gray' : undefined}
            size={size}
            loading={voice === 'transcribing'}
            aria-label={voiceBlock ?? (voice === 'recording' ? 'Finish and transcribe' : 'Dictate')}
            aria-disabled={voiceBlock !== null}
            style={{ position: 'relative', overflow: 'visible' }}
            onMouseEnter={() => setMicHovered(true)}
            onMouseLeave={() => setMicHovered(false)}
            onClick={() => {
              // A tooltip never shows on a phone tap, so the unfixable case
              // says itself in the composer instead.
              if (voiceBlock) {
                if (voiceBlockActionable) setSettingsSection('voice');
                else setVoiceError(voiceBlock);
                return;
              }
              void (voice === 'recording' ? finishVoice() : startVoice());
            }}
          >
            {/* Only the glyph fades: opacity on the button would fade the
                warning dot with it, on exactly the state it exists for. */}
            {voice === 'recording' ? (
              <IconCheck size={iconSize} />
            ) : (
              <IconMicrophone size={iconSize} opacity={voiceBlock ? 0.5 : 1} />
            )}
            {voiceBlock && micHovered && (
              <ThemeIcon
                size={12}
                radius="xl"
                color="orange"
                variant="filled"
                style={{ position: 'absolute', top: -2, right: -2, pointerEvents: 'none' }}
              >
                <IconAlertTriangle size={8} />
              </ThemeIcon>
            )}
          </ActionIcon>
        </Tooltip>
      </Group>
    );

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const encoded = await Promise.all(list.map(fileToAttachment));
    setAttachments((a) => [...a, ...encoded]);
  };

  const submit = () => {
    // Guards ⌘/Enter too, not just the buttons — the keyboard path is the one
    // that would otherwise send into a machine that cannot run it.
    if (cannotSend) return;
    // Bake the @mention expansions into the text (so workflow-first-prompt and
    // offline queueing see it too); `mentions` rides along display-only.
    const expanded = buildExpandedPrompt(prompt.text.trim(), prompt.ranges);
    const wireMentions = uniqueMentions(prompt.ranges).map(({ kind, id, label, detail }) => ({
      kind,
      id,
      label,
      detail,
    }));
    send({
      type: 'prompt',
      sessionId: session.id,
      text: expanded,
      attachments,
      mentions: wireMentions.length ? wireMentions : undefined,
      // Kept only if the server queues this prompt, so the queue row can be
      // re-opened in a composer with its pills instead of the expanded text.
      draft: prompt.ranges.length ? prompt : undefined,
    });
    setPrompt({ text: '', ranges: [] });
    setAttachments([]);
  };

  const setPermissionMode = (mode: PermissionMode) =>
    send({ type: 'setPermissionMode', sessionId: session.id, mode });

  const permissionModeControl = (
    <SegmentedControl
      size="xs"
      disabled={!canSetMode || !caps.approvals}
      data={PERMISSION_MODE_SEGMENTS}
      value={session.permissionMode}
      onChange={(v) => setPermissionMode(v as PermissionMode)}
    />
  );

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
        onChange={(v) => {
          if (!v || v === session.model) return;
          // Crossing providers on a session that has run drops its
          // conversation, so it is confirmed rather than dispatched.
          if (hasRun && providerForModel(v) !== provider) {
            setOptionsOpen(false);
            setSwitchTo(v);
            return;
          }
          send({ type: 'setModel', sessionId: session.id, model: v });
        }}
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
            onChange={(v) =>
              v &&
              send({
                type: 'setReasoningEffort',
                sessionId: session.id,
                effort: v === AUTO_EFFORT ? null : (v as ReasoningEffort),
              })
            }
            allowDeselect={false}
          />
        </span>
      </Tooltip>
      {routingOn && (
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
      )}
    </>
  );
  const stopWork = () =>
    send(
      interruptible
        ? { type: 'interrupt', sessionId: session.id }
        : { type: 'stopBackgroundTasks', sessionId: session.id },
    );

  return (
    // On a phone the composer is a strip across the bottom rather than a card:
    // no corners, no side or bottom border, no margin. The footer row's
    // `lines-safe-bottom` still keeps Send above the home indicator.
    <Paper
      withBorder
      radius={isPhone ? 0 : 'lg'}
      p="xs"
      pb={isPhone ? 0 : undefined}
      m={isPhone ? 0 : 'md'}
      mt={isPhone ? 0 : 4}
      maw={920}
      mx={isPhone ? 0 : 'auto'}
      w="100%"
      style={{
        position: 'relative',
        ...(isPhone && { borderLeft: 'none', borderRight: 'none', borderBottom: 'none' }),
        borderColor: dragging
          ? 'var(--mantine-primary-color-filled)'
          : remote.isRemote
            ? 'var(--mantine-color-grape-5)'
            : undefined,
      }}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
      }}
    >
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
      {attachments.length > 0 && (
        <Group gap="xs" px={6} pb={6}>
          {attachments.map((att, i) => (
            <PreviewTile
              key={i}
              att={att}
              onOpen={() => setLightbox(`data:${att.mediaType};base64,${att.data}`)}
              onRemove={() => setAttachments((a) => a.filter((_, j) => j !== i))}
            />
          ))}
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
          Offline — messages are queued and sent on reconnect
          {queuedCount > 0 ? ` · ${queuedCount} queued` : ''}
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
        // a banner — ConnectionBanner/WorkerBanner/StorageBanner keep their own
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
              : `Message ${provider === 'openai' ? 'Codex' : 'Claude'}…${isPhone ? '' : ' (↵ to send, ⇧↵ for newline)'}`
          }
          textareaRef={textareaRef}
          handleRef={mentionRef}
          minRows={isPhone ? 1 : 2}
          onFocusChange={setComposerFocused}
          onPasteFiles={(files) => void addFiles(files)}
        />
        {voice === 'recording' && voiceLevel && (
          // ChatGPT-style: while recording, the input *is* the waveform. A Paper
          // so it takes the composer's own background, whatever the theme.
          <Paper
            style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex', alignItems: 'center' }}
            px={4}
          >
            <Group gap="xs" wrap="nowrap" w="100%">
              <Box style={{ flex: 1, minWidth: 0 }} c="dimmed">
                <VoiceWaveform level={voiceLevel} height={isPhone ? 24 : 32} />
              </Box>
              <Text size="xs" c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatElapsed(voiceElapsed)}
              </Text>
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
          </Group>
          <Group gap={4} wrap="nowrap">
            {/* Beside Send, where a mic is expected to be: dictating is the
                other way of writing the message that button sends. */}
            {micControl(18)}
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
            <Button px={10} disabled={cannotSend} onClick={submit}>
              {interruptible ? 'Queue' : 'Send'}
            </Button>
          </Group>
        </Group>
      ) : (
        <>
          {/* `wrap` rather than `nowrap`: at 390px the model and effort selects do
          not fit beside the mode pills, and a horizontally clipped row hides the
          send button. Wrapping costs a line of height on a phone and nothing on
          a desktop, where the row has always fitted. */}
          <Group
            justify="space-between"
            px={4}
            pt={4}
            wrap="wrap"
            gap={6}
            className="lines-safe-bottom"
          >
            <Group gap="xs" wrap="wrap">
              <Tooltip label="Attach files">
                <ActionIcon
                  variant="subtle"
                  size="lg"
                  aria-label="Attach files"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <IconPaperclip size={16} />
                </ActionIcon>
              </Tooltip>
              {/* Visible but disabled for a codex session, deliberately: its absence
              would read as a bug, and the tooltip is where the reduced surface
              gets explained. A span so the tooltip fires over a disabled control.
              Only wrapped in that disabled state — each segment carries its own
              description tooltip, and a second one on the control fights them. */}
              {caps.approvals ? (
                permissionModeControl
              ) : (
                <Tooltip
                  label={
                    'This session runs sandboxed and approves its own tool calls. ' +
                    'Plan mode is read-only here, and your MCP connections do not apply.'
                  }
                  withArrow
                  openDelay={400}
                >
                  <span style={{ display: 'inline-flex' }}>{permissionModeControl}</span>
                </Tooltip>
              )}
              {modelControls}
            </Group>
            <Group gap="xs">
              <ContextWindowIndicator session={session} />
              {session.totalCostUsd != null && (
                <Text size="xs" c="dimmed">
                  {formatSpendUsd(session.totalCostUsd, hasEstimatedSpend(session.costByModel))}
                </Text>
              )}
              {micControl(16, 'lg')}
              {interruptible || bgTasks > 0 ? (
                <>
                  <Tooltip
                    label={
                      interruptible
                        ? 'Queue message — sends after the current turn'
                        : 'Send — the background task keeps running'
                    }
                  >
                    <ActionIcon
                      variant={interruptible ? 'subtle' : 'filled'}
                      size="lg"
                      aria-label={interruptible ? 'Queue message' : 'Send message'}
                      onClick={submit}
                      disabled={cannotSend}
                    >
                      <IconSend size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip
                    label={
                      !interruptible
                        ? 'Stop background work'
                        : session.workflow?.started &&
                            session.workflow.stepStatuses[session.workflow.stepIndex] === 'running'
                          ? 'Stop — the step will wait for your review'
                          : 'Interrupt'
                    }
                  >
                    <ActionIcon
                      color="gray"
                      variant="default"
                      size="lg"
                      disabled={!canInterrupt}
                      aria-label="Stop work"
                      onClick={stopWork}
                    >
                      <IconPlayerStop size={16} />
                    </ActionIcon>
                  </Tooltip>
                </>
              ) : awaitingApproval ? (
                <Tooltip label="Send — keeps iterating on this step (won't advance the workflow)">
                  <ActionIcon
                    variant="filled"
                    size="lg"
                    aria-label={interruptible ? 'Queue message' : 'Send message'}
                    onClick={submit}
                    disabled={cannotSend}
                  >
                    <IconSend size={16} />
                  </ActionIcon>
                </Tooltip>
              ) : (
                <ActionIcon
                  variant="filled"
                  size="lg"
                  aria-label={interruptible ? 'Queue message' : 'Send message'}
                  onClick={submit}
                  disabled={cannotSend}
                >
                  <IconSend size={16} />
                </ActionIcon>
              )}
            </Group>
          </Group>
        </>
      )}
      {/* Sized by its content, not by a share of the screen: a sheet pinned at
          80dvh is the same height whether it holds four controls or one, and
          four controls do not fill a phone. The max-height on `.lines-mobile-sheet`
          is what stops a long one running off the top. */}
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
          {session.totalCostUsd != null &&
            (!caps.contextWindow || (!session.contextSummary && !session.contextUsage)) && (
              <Text size="xs" c="dimmed">
                Session cost{' '}
                {formatSpendUsd(session.totalCostUsd, hasEstimatedSpend(session.costByModel))}
              </Text>
            )}
        </Stack>
      </Drawer>
      {/* Opened only from a model's or the mic's warning icon — the pane that carries the
          version, the floor and the install command. Rendered here, exactly as
          StorageBanner opens its own copy at Diagnostics. */}
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
              maxHeight: '90vh',
              display: 'block',
              borderRadius: 8,
            }}
          />
        )}
      </Modal>
    </Paper>
  );
}
