/**
 * The DOM-free half of image downscaling (see imageDownscale.ts): which
 * attachments get resized, and to what size. Separate so the server's test
 * runner, which has no DOM types, can import it.
 */

/** Longest edge a prompt image is resized to. Claude downsizes past ~1568px anyway. */
export const ATTACHMENT_MAX_EDGE = 2048;
/** A file at or under this size, already within the edge limit, is sent untouched. */
export const ATTACHMENT_SKIP_BYTES = 1024 * 1024;
/** A resized PNG under this size stays PNG, so screenshot text stays sharp. */
export const ATTACHMENT_PNG_KEEP_BYTES = 1.5 * 1024 * 1024;
export const ATTACHMENT_JPEG_QUALITY = 0.85;

/**
 * Image types worth re-encoding. GIF is left alone (re-encoding drops its
 * animation), SVG is not a bitmap, and anything else is not an image at all.
 */
const DOWNSCALABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

export function isDownscalableType(type: string): boolean {
  return DOWNSCALABLE_TYPES.has(type.toLowerCase());
}

/**
 * Whether a prompt attachment should be resized. Pure, so it is testable
 * without a canvas. A small image already within the edge limit stays
 * byte-identical: a screenshot loses nothing by being sent as it is.
 */
export function shouldDownscale({
  type,
  size,
  width,
  height,
  maxEdge = ATTACHMENT_MAX_EDGE,
  skipBytes = ATTACHMENT_SKIP_BYTES,
}: {
  type: string;
  size: number;
  width: number;
  height: number;
  maxEdge?: number;
  skipBytes?: number;
}): boolean {
  if (!isDownscalableType(type)) return false;
  return size > skipBytes || Math.max(width, height) > maxEdge;
}

/**
 * Target dimensions with the longest edge at most `maxEdge`, aspect kept.
 * Computed before anything is drawn, so an oversized source never needs a
 * canvas of its own size (iOS caps canvas area at ~16.7MP).
 */
export function targetSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  const scale = longest > 0 ? Math.min(1, maxEdge / longest) : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Swap a file name's extension (or add one), e.g. `IMG_0001.HEIC` to `IMG_0001.jpg`. */
export function withExtension(name: string, ext: string): string {
  const base = name.replace(/\.[^./]+$/, '') || name;
  return `${base}.${ext}`;
}
