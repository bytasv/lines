const FAVICON_SRC = '/favicon.png';
// Matches Mantine blue-6 / red-6 used by the sidebar status dots.
const RUNNING_BLUE = '#228be6';
const ATTENTION_RED = '#fa5252';

interface FaviconState {
  attention: number;
  running: boolean;
}

let baseImage: Promise<HTMLImageElement> | null = null;
let pending: FaviconState | null = null;
let lastKey = '';

function loadBase(): Promise<HTMLImageElement> {
  if (!baseImage) {
    baseImage = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = FAVICON_SRC;
    });
  }
  return baseImage;
}

function faviconLink(): HTMLLinkElement | null {
  return document.querySelector('link[rel="icon"]');
}

function restorePlain(): void {
  const link = faviconLink();
  if (!link) return;
  link.type = 'image/png';
  link.href = FAVICON_SRC;
}

function drawLogo(ctx: CanvasRenderingContext2D, img: HTMLImageElement, size: number): void {
  const ratio = img.width / img.height;
  let w = size;
  let h = size;
  if (ratio > 1) h = size / ratio;
  else w = size * ratio;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
}

function render(img: HTMLImageElement, state: FaviconState): void {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  drawLogo(ctx, img, size);

  if (state.attention > 0) {
    const r = size * 0.34;
    const cx = size - r;
    const cy = size - r;
    ctx.fillStyle = ATTENTION_RED;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(r * 1.3)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = state.attention > 9 ? '9+' : String(state.attention);
    ctx.fillText(label, cx, cy + 1);
  } else {
    const r = size * 0.22;
    const cx = size - r - 2;
    const cy = size - r - 2;
    ctx.fillStyle = RUNNING_BLUE;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const link = faviconLink();
  if (!link) return;
  link.type = 'image/png';
  link.href = canvas.toDataURL('image/png');
}

/** Reflect sessions needing attention (count badge) or running (blue dot) on the favicon. */
export function updateFavicon(state: FaviconState): void {
  const key = `${state.attention}|${state.running}`;
  if (key === lastKey) return;
  lastKey = key;

  if (state.attention === 0 && !state.running) {
    restorePlain();
    return;
  }

  try {
    pending = state;
    void loadBase()
      .then((img) => {
        if (pending) render(img, pending);
      })
      .catch(() => {
        // ignore — title badge still conveys the count
      });
  } catch {
    // ignore
  }
}
