// Detects CSS color literals (hex, rgb()/rgba(), hsl()/hsla()) in message text
// so the UI can append inline color swatches. Loose regex match, then exact
// validation via CSS.supports so the browser's own parser is the authority.

// Hex: 3/4/6/8 digits. Lookbehind blocks &#123; entities, URL anchors and
// mid-token hits; lookahead blocks longer tokens (#deadbeef12, #fffz).
const HEX_SRC =
  '(?<![\\w&-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\\w-])';
// Functional: no nested parens (excludes calc()/var() forms), covers comma and
// modern space/slash syntax; validated afterwards.
const FN_SRC = '(?<![\\w-])(?:rgba?|hsla?)\\(\\s*[^()]{1,60}\\)';

export const COLOR_RE = new RegExp(`${HEX_SRC}|${FN_SRC}`, 'gi');

/** Guard against pathological messages with thousands of matches. */
const MAX_MATCHES = 100;

const supportsCache = new Map<string, boolean>();

function isValidColor(value: string): boolean {
  let ok = supportsCache.get(value);
  if (ok === undefined) {
    ok = CSS.supports('color', value);
    supportsCache.set(value, ok);
  }
  return ok;
}

export interface ColorMatch {
  start: number;
  end: number;
  value: string;
}

export function findColorLiterals(text: string): ColorMatch[] {
  COLOR_RE.lastIndex = 0;
  const out: ColorMatch[] = [];
  let m: RegExpExecArray | null;
  while (out.length < MAX_MATCHES && (m = COLOR_RE.exec(text)) !== null) {
    if (!isValidColor(m[0])) continue;
    out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
  }
  return out;
}

export interface ColorDetails {
  hex: string;
  rgb: string;
}

let canvasCtx: CanvasRenderingContext2D | null | undefined;
const detailsCache = new Map<string, ColorDetails | null>();

/**
 * Normalize any browser-accepted color to hex + rgb strings via the canvas
 * fillStyle readback trick: assignment normalizes to '#rrggbb' (opaque) or
 * 'rgba(r, g, b, a)' (alpha). Dependency-free, matches what actually renders.
 */
export function colorDetails(value: string): ColorDetails | null {
  let details = detailsCache.get(value);
  if (details !== undefined) return details;

  if (canvasCtx === undefined) {
    canvasCtx = document.createElement('canvas').getContext('2d');
  }
  details = null;
  if (canvasCtx) {
    canvasCtx.fillStyle = '#000000';
    canvasCtx.fillStyle = value;
    const normalized = String(canvasCtx.fillStyle);
    let r = 0, g = 0, b = 0, a = 1;
    let parsed = false;
    if (normalized.startsWith('#')) {
      r = parseInt(normalized.slice(1, 3), 16);
      g = parseInt(normalized.slice(3, 5), 16);
      b = parseInt(normalized.slice(5, 7), 16);
      parsed = true;
    } else {
      const m = normalized.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
      if (m) {
        r = Number(m[1]);
        g = Number(m[2]);
        b = Number(m[3]);
        a = m[4] === undefined ? 1 : Number(m[4]);
        parsed = true;
      }
    }
    if (parsed) {
      const toHex = (n: number) => n.toString(16).padStart(2, '0');
      const alphaHex = a < 1 ? toHex(Math.round(a * 255)) : '';
      details = {
        hex: `#${toHex(r)}${toHex(g)}${toHex(b)}${alphaHex}`,
        rgb: a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`,
      };
    }
  }
  detailsCache.set(value, details);
  return details;
}
