import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Box,
  Group,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import { IconAlertTriangle, IconChevronLeft, IconChevronRight, IconUpload, IconX } from '@tabler/icons-react';
import { RECIPE_IMAGE_MAX_COUNT, RECIPE_IMAGE_TYPES } from '@lines/shared';
import { useStore } from '../../store';
import { prepareRecipeImage } from '../../lib/recipeImage';
import { send } from '../../ws';

/** An upload the bridge never answered is treated as failed; there is no per-upload error message. */
const UPLOAD_DEADLINE_MS = 30_000;

/**
 * Screenshot strip for the recipe editor: drop/pick files, downscale them, hand
 * them to the bridge and keep the returned public URLs in display order.
 *
 * Uploads are fire-and-forget over the socket — nothing is staged locally (no
 * IndexedDB): a screenshot that fails to reach R2 must never block saving the
 * recipe, which is the part that actually matters.
 */
export function RecipeImages({
  images,
  readOnly,
  onChange,
}: {
  images: string[];
  readOnly: boolean;
  onChange: (images: string[]) => void;
}) {
  const uploads = useStore((s) => s.recipeUploads);
  const trackRecipeUpload = useStore((s) => s.trackRecipeUpload);
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const remaining = RECIPE_IMAGE_MAX_COUNT - images.length - pending.length;

  // Adopt finished uploads. Kept in an effect (not the send callback) so the
  // reply is handled the same way whichever tab/socket event delivers it.
  useEffect(() => {
    if (pending.length === 0) return;
    const done = pending.filter((id) => uploads[id]?.url || uploads[id]?.error);
    if (done.length === 0) return;
    const urls = done.map((id) => uploads[id]?.url).filter((u): u is string => !!u);
    const failed = done.find((id) => uploads[id]?.error);
    setPending((p) => p.filter((id) => !done.includes(id)));
    for (const id of done) trackRecipeUpload(id, null);
    if (failed) setError(uploads[failed]?.error ?? 'Upload failed.');
    if (urls.length) onChange([...images, ...urls].slice(0, RECIPE_IMAGE_MAX_COUNT));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploads, pending]);

  const addFiles = async (files: FileList) => {
    const picked = [...files].filter((f) => (RECIPE_IMAGE_TYPES as readonly string[]).includes(f.type));
    if (picked.length < files.length) setError('Only PNG, JPEG, WebP and GIF images can be attached.');
    for (const file of picked.slice(0, Math.max(0, remaining))) {
      const uploadId = crypto.randomUUID();
      try {
        const image = await prepareRecipeImage(file);
        trackRecipeUpload(uploadId, { name: image.name });
        setPending((p) => [...p, uploadId]);
        send({ type: 'uploadRecipeImage', uploadId, ...image });
        window.setTimeout(() => {
          const entry = useStore.getState().recipeUploads[uploadId];
          if (entry && !entry.url) trackRecipeUpload(uploadId, { error: 'Upload timed out — image hosting may be unconfigured.' });
        }, UPLOAD_DEADLINE_MS);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not prepare the image.');
      }
    }
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= images.length) return;
    const next = [...images];
    next.splice(to, 0, ...next.splice(from, 1));
    onChange(next);
  };

  return (
    <Stack gap="xs">
      {(images.length > 0 || pending.length > 0) && (
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
          {images.map((url, i) => (
            <Paper key={url} withBorder radius="md" style={{ position: 'relative', overflow: 'hidden', aspectRatio: '16 / 10' }}>
              <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              {!readOnly && (
                <Group gap={2} style={{ position: 'absolute', top: 4, right: 4 }}>
                  <ActionIcon size="sm" variant="filled" color="dark" onClick={() => move(i, i - 1)} disabled={i === 0}>
                    <IconChevronLeft size={13} />
                  </ActionIcon>
                  <ActionIcon size="sm" variant="filled" color="dark" onClick={() => move(i, i + 1)} disabled={i === images.length - 1}>
                    <IconChevronRight size={13} />
                  </ActionIcon>
                  <ActionIcon size="sm" variant="filled" color="dark" onClick={() => onChange(images.filter((_, j) => j !== i))}>
                    <IconX size={13} />
                  </ActionIcon>
                </Group>
              )}
            </Paper>
          ))}
          {pending.map((id) => (
            <Paper key={id} withBorder radius="md" style={{ aspectRatio: '16 / 10', display: 'grid', placeItems: 'center' }}>
              <Loader size="xs" />
            </Paper>
          ))}
        </SimpleGrid>
      )}

      {!readOnly && remaining > 0 && (
        <Box
          onClick={() => fileInputRef.current?.click()}
          onDragEnter={(e) => {
            if (e.dataTransfer.types.includes('Files')) setDragging(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
          }}
          style={{
            padding: 14,
            borderRadius: 'var(--mantine-radius-md)',
            border: `2px dashed ${dragging ? 'var(--mantine-primary-color-filled)' : 'var(--mantine-color-dark-4)'}`,
            cursor: 'pointer',
          }}
        >
          <Group gap={8} justify="center">
            <IconUpload size={16} opacity={0.7} />
            <Text size="xs" c="dimmed">
              Drop screenshots or click to pick — {remaining} of {RECIPE_IMAGE_MAX_COUNT} left
            </Text>
          </Group>
        </Box>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        accept={RECIPE_IMAGE_TYPES.join(',')}
        onChange={(e) => {
          if (e.currentTarget.files) void addFiles(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />

      {error && (
        <Alert variant="light" color="yellow" p="xs" icon={<IconAlertTriangle size={16} />} withCloseButton onClose={() => setError(null)}>
          <Text size="xs">{error} The recipe still saves without screenshots.</Text>
        </Alert>
      )}
    </Stack>
  );
}
