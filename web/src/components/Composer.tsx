import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Box,
  Group,
  Modal,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Tooltip,
} from '@mantine/core';
import { useHover } from '@mantine/hooks';
import {
  IconFile,
  IconPaperclip,
  IconPlayerStop,
  IconSend,
  IconUpload,
  IconX,
  IconZoomIn,
} from '@tabler/icons-react';
import type { CavemanLevel, PermissionMode, PromptAttachment, SessionMeta } from '@lines/shared';
import { isSessionInterruptible, rootsForCwd } from '@lines/shared';
import { readDraft, readDraftAttachments, useStore, writeDraft, writeDraftAttachments } from '../store';
import { modelComboboxProps, modelSelectData, renderModelOption } from '../lib/modelSelect';
import { PERMISSION_MODE_SEGMENTS } from '../lib/permissionModes';
import { buildExpandedPrompt, uniqueMentions } from '../lib/mentions';
import { linkedMachineHealth } from '../lib/machineHealth';
import { useCan, useSessionMachine, useSessionMachineHealth } from '../lib/can';
import { usePresence } from '../lib/presence';
import { ContextWindowIndicator } from './ContextWindowIndicator';
import { MentionInput } from './MentionInput';
import { send } from '../ws';

/** Read a File into a raw-base64 PromptAttachment (strips the data: URI prefix). */
function fileToAttachment(file: File): Promise<PromptAttachment> {
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
      style={{ position: 'relative', width: 64, height: 64, overflow: 'hidden', flexShrink: 0, cursor: isImage ? 'zoom-in' : 'default' }}
    >
      {isImage ? (
        <>
          <img
            src={`data:${att.mediaType};base64,${att.data}`}
            alt={att.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
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
  const models = useStore((s) => s.models);
  const projects = useStore((s) => s.projects);
  const connectionStatus = useStore((s) => s.connectionStatus);
  const queuedCount = useStore((s) => s.queuedPrompts.filter((q) => q.sessionId === session.id).length);
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
  const interruptible = isSessionInterruptible(session.status);
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

  // Focus the prompt on a freshly created session (reuses the store's 5s justCreated heuristic).
  useEffect(() => {
    if (Date.now() - session.createdAt < 5000) textareaRef.current?.focus();
  }, [session.id]);

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
    });
    setPrompt({ text: '', ranges: [] });
    setAttachments([]);
  };

  return (
    <Paper
      withBorder
      radius="lg"
      p="xs"
      m="md"
      mt={4}
      maw={920}
      mx="auto"
      w="100%"
      style={{
        position: 'relative',
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
      <MentionInput
        value={prompt}
        onChange={setPrompt}
        onSubmit={submit}
        cwd={session.cwd}
        roots={rootsForCwd(projects, session.cwd)}
        placeholder={
          session.workflow && !session.workflow.started
            ? 'Describe the task — this kicks off the workflow…'
            : 'Message Claude… (↵ to send, ⇧↵ for newline)'
        }
        textareaRef={textareaRef}
        onFocusChange={setComposerFocused}
        onPasteFiles={(files) => void addFiles(files)}
      />
      <Group justify="space-between" px={4} pt={4}>
        <Group gap="xs">
          <Tooltip label="Attach files">
            <ActionIcon variant="subtle" size="lg" onClick={() => fileInputRef.current?.click()}>
              <IconPaperclip size={16} />
            </ActionIcon>
          </Tooltip>
          <SegmentedControl
            size="xs"
            disabled={!canSetMode}
            data={PERMISSION_MODE_SEGMENTS}
            value={session.permissionMode}
            onChange={(v) =>
              send({ type: 'setPermissionMode', sessionId: session.id, mode: v as PermissionMode })
            }
          />
          <Select
            w={130}
            disabled={!canSetModel}
            comboboxProps={modelComboboxProps}
            data={modelSelectData(models, session.model)}
            renderOption={renderModelOption}
            value={session.model}
            onChange={(v) => v && send({ type: 'setModel', sessionId: session.id, model: v })}
            allowDeselect={false}
          />
          <Tooltip label="Caveman mode — compressed replies, fewer tokens">
            <Switch
              label="🦴"
              disabled={!canSetMode}
              checked={session.caveman.enabled}
              onChange={(e) =>
                send({
                  type: 'setCaveman',
                  sessionId: session.id,
                  caveman: { ...session.caveman, enabled: e.currentTarget.checked },
                })
              }
            />
          </Tooltip>
          {session.caveman.enabled && (
            <Select
              w={80}
              size="xs"
              data={['lite', 'full', 'ultra']}
              value={session.caveman.level}
              onChange={(v) =>
                v &&
                send({
                  type: 'setCaveman',
                  sessionId: session.id,
                  caveman: { ...session.caveman, level: v as CavemanLevel },
                })
              }
              allowDeselect={false}
            />
          )}
        </Group>
        <Group gap="xs">
          <ContextWindowIndicator session={session} />
          {session.totalCostUsd != null && (
            <Text size="xs" c="dimmed">
              ${session.totalCostUsd.toFixed(3)}
            </Text>
          )}
          {interruptible ? (
            <>
              <Tooltip label="Queue message — sends after the current turn">
                <ActionIcon
                  variant="subtle"
                  size="lg"
                  onClick={submit}
                  disabled={cannotSend}
                >
                  <IconSend size={16} />
                </ActionIcon>
              </Tooltip>
              <Tooltip
                label={
                  session.workflow?.started &&
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
                  onClick={() => send({ type: 'interrupt', sessionId: session.id })}
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
              onClick={submit}
              disabled={cannotSend}
            >
              <IconSend size={16} />
            </ActionIcon>
          )}
        </Group>
      </Group>
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
            style={{ maxWidth: '90vw', maxHeight: '90vh', display: 'block', borderRadius: 8 }}
          />
        )}
      </Modal>
    </Paper>
  );
}
