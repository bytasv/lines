import type { PromptAttachment } from '@lines/shared';
import {
  ATTACHMENT_JPEG_QUALITY,
  ATTACHMENT_MAX_EDGE,
  ATTACHMENT_PNG_KEEP_BYTES,
  isDownscalableType,
  shouldDownscale,
  targetSize,
  withExtension,
} from './imageDownscalePolicy';

/**
 * Browser-side image downscaling, shared by recipe screenshots and prompt
 * attachments. A phone photo is routinely 8-12MB; over a relay link that is a
 * single 16MB base64 frame, which stalls the socket (pongs included) for as long
 * as the uplink needs. Shrinking it before it leaves the browser is what keeps an
 * attach from feeling stuck.
 */

/** Read a Blob into raw base64, without the `data:` URI prefix. */
export function blobToBase64(blob: Blob): Promise<string> {
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

export function loadImage(file: Blob): Promise<HTMLImageElement> {
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

function drawScaled(img: HTMLImageElement, maxEdge: number): HTMLCanvasElement {
  const { width, height } = targetSize(img.naturalWidth, img.naturalHeight, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable in this browser.');
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))), type, quality),
  );
}

/** Resize to `maxEdge` on the longest edge and re-encode. Throws when the image cannot be decoded. */
export async function downscaleImage(
  file: Blob,
  { maxEdge, type, quality }: { maxEdge: number; type: string; quality?: number },
): Promise<{ blob: Blob; width: number; height: number }> {
  const canvas = drawScaled(await loadImage(file), maxEdge);
  return { blob: await encode(canvas, type, quality), width: canvas.width, height: canvas.height };
}

/**
 * A picked file as a prompt attachment, downscaled when it is a large photo.
 *
 * Never blocks the attach: an image the browser cannot decode (HEIC on desktop
 * Chrome) or encode goes out as its original bytes, exactly as before.
 */
export async function prepareAttachment(file: File): Promise<PromptAttachment> {
  const original = async (): Promise<PromptAttachment> => ({
    name: file.name,
    mediaType: file.type || 'application/octet-stream',
    data: await blobToBase64(file),
  });
  if (!isDownscalableType(file.type)) return original();

  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    return original();
  }
  if (!shouldDownscale({ type: file.type, size: file.size, width: img.naturalWidth, height: img.naturalHeight })) {
    return original();
  }

  try {
    const canvas = drawScaled(img, ATTACHMENT_MAX_EDGE);
    if (file.type.toLowerCase() === 'image/png') {
      const png = await encode(canvas, 'image/png');
      if (png.size <= ATTACHMENT_PNG_KEEP_BYTES) {
        return { name: file.name, mediaType: 'image/png', data: await blobToBase64(png) };
      }
    }
    const jpeg = await encode(canvas, 'image/jpeg', ATTACHMENT_JPEG_QUALITY);
    // A resize that somehow grew the file is no win; keep the original.
    if (jpeg.size >= file.size) return original();
    return { name: withExtension(file.name, 'jpg'), mediaType: 'image/jpeg', data: await blobToBase64(jpeg) };
  } catch {
    return original();
  }
}
