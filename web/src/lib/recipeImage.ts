import { RECIPE_IMAGE_MAX_BYTES } from '@lines/shared';
import { blobToBase64, downscaleImage } from './imageDownscale';

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

/**
 * Downscale to `MAX_EDGE` on the longest edge and re-encode as WebP, ready for
 * `uploadRecipeImage`. Throws when the result still exceeds the shared cap, so
 * the caller can say so inline rather than letting the bridge reject it.
 */
export async function prepareRecipeImage(file: File): Promise<RecipeImageUpload> {
  const { blob } = await downscaleImage(file, { maxEdge: MAX_EDGE, type: 'image/webp', quality: WEBP_QUALITY });
  if (blob.size > RECIPE_IMAGE_MAX_BYTES) {
    throw new Error(`Image is too large (${Math.round(blob.size / 1024 / 1024)}MB after resizing).`);
  }

  return {
    name: `${file.name.replace(/\.[^.]+$/, '')}.webp`,
    mediaType: 'image/webp',
    data: await blobToBase64(blob),
  };
}
