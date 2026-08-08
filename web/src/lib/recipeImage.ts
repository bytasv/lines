import { RECIPE_IMAGE_MAX_BYTES } from '@lines/shared';

/**
 * Recipe screenshots are decoration on a browse list, never assets: a phone
 * screenshot is routinely 8-12MB, which the 2MB bridge cap rejects outright.
 * Downscaling in the browser turns "upload failed" into "upload worked" without
 * asking the user to resize anything.
 */
const MAX_EDGE = 2000;
const WEBP_QUALITY = 0.85;

export interface RecipeImageUpload {
  name: string;
  mediaType: string;
  /** Raw base64, no `data:` prefix — the wire format `uploadRecipeImage` expects. */
  data: string;
}

/** Read a Blob into raw base64 (same idiom as Composer's `fileToAttachment`). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Not a readable image.'));
    };
    img.src = url;
  });
}

/**
 * Downscale to `MAX_EDGE` on the longest edge and re-encode as WebP, ready for
 * `uploadRecipeImage`. Throws when the result still exceeds the shared cap, so
 * the caller can say so inline rather than letting the bridge reject it.
 */
export async function prepareRecipeImage(file: File): Promise<RecipeImageUpload> {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable in this browser.');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', WEBP_QUALITY),
  );
  if (!blob) throw new Error('Could not encode the image.');
  if (blob.size > RECIPE_IMAGE_MAX_BYTES) {
    throw new Error(`Image is too large (${Math.round(blob.size / 1024 / 1024)}MB after resizing).`);
  }

  return {
    name: `${file.name.replace(/\.[^.]+$/, '')}.webp`,
    mediaType: 'image/webp',
    data: await blobToBase64(blob),
  };
}
