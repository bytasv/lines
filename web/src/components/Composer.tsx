import { useRef, useState } from 'react';
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
  Textarea,
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
import type { CavemanLevel, PermissionMode, PromptAttachment, SessionMeta } from '@claude-ui/shared';
import { useStore } from '../store';
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

const MODE_LABELS: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Agent' },
  { value: 'auto', label: 'Auto' },
  { value: 'acceptEdits', label: 'Edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' },
];

export function Composer({ session }: { session: SessionMeta }) {
  const models = useStore((s) => s.models);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const running = session.status === 'running' || session.status === 'waiting-permission';

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const encoded = await Promise.all(list.map(fileToAttachment));
    setAttachments((a) => [...a, ...encoded]);
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    send({ type: 'prompt', sessionId: session.id, text: trimmed, attachments });
    setText('');
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
        borderColor: dragging ? 'var(--mantine-primary-color-filled)' : undefined,
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
      <Textarea
        placeholder={
          session.workflow && !session.workflow.started
            ? 'Describe the task — this kicks off the workflow…'
            : 'Message Claude… (↵ to send, ⇧↵ for newline)'
        }
        autosize
        minRows={2}
        maxRows={10}
        variant="unstyled"
        px={6}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (files.length) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
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
            data={MODE_LABELS}
            value={session.permissionMode}
            onChange={(v) =>
              send({ type: 'setPermissionMode', sessionId: session.id, mode: v as PermissionMode })
            }
          />
          <Select
            w={130}
            data={models.map((m) => ({ value: m.id, label: m.label }))}
            value={session.model}
            onChange={(v) => v && send({ type: 'setModel', sessionId: session.id, model: v })}
            allowDeselect={false}
          />
          <Tooltip label="Caveman mode — compressed replies, fewer tokens">
            <Switch
              size="xs"
              label="🦴"
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
          {session.totalCostUsd != null && (
            <Text size="xs" c="dimmed">
              ${session.totalCostUsd.toFixed(3)}
            </Text>
          )}
          {running ? (
            <Tooltip label="Interrupt">
              <ActionIcon color="red" variant="light" size="lg" onClick={() => send({ type: 'interrupt', sessionId: session.id })}>
                <IconPlayerStop size={16} />
              </ActionIcon>
            </Tooltip>
          ) : (
            <ActionIcon
              variant="filled"
              size="lg"
              onClick={submit}
              disabled={!text.trim() && attachments.length === 0}
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
