import { useEffect, useRef } from 'react';

/** Bar geometry, in CSS pixels. */
const BAR_WIDTH = 3;
const BAR_GAP = 2;
/** How often a new bar enters on the right. ChatGPT-like: a steady scroll,
 *  not a jitter at display refresh rate. */
const SAMPLE_EVERY_MS = 60;

/**
 * The live recording waveform: bars scrolling right to left, each one the mic's
 * loudness at the moment it entered. Drawn on a canvas in the text colour
 * (`currentColor`), so it follows the theme and whatever `c` the parent sets.
 *
 * `level` is read on every animation frame and must be cheap — the recorder's
 * analyser tap is.
 */
export function VoiceWaveform({ level, height = 32 }: { level: () => number; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    /** Newest last. Grows to fit the width; older bars fall off the left. */
    const bars: number[] = [];
    let lastSample = 0;
    let raf = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const capacity = Math.max(1, Math.floor(width / (BAR_WIDTH + BAR_GAP)));
      if (now - lastSample >= SAMPLE_EVERY_MS) {
        lastSample = now;
        // Speech RMS sits around 0.01–0.2; the square root and the gain make a
        // normal voice fill most of the height without clipping on a shout.
        bars.push(Math.min(1, Math.sqrt(level()) * 1.8));
        if (bars.length > capacity) bars.splice(0, bars.length - capacity);
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = getComputedStyle(canvas).color;
      // Right-aligned: the newest bar hugs the right edge, as the timer beside
      // it does, and the left fills in as the recording grows.
      const offset = width - bars.length * (BAR_WIDTH + BAR_GAP);
      for (let i = 0; i < bars.length; i++) {
        const h = Math.max(2, bars[i] * height);
        const x = offset + i * (BAR_WIDTH + BAR_GAP);
        // roundRect is Safari 16+; square bars are fine on anything older.
        if (typeof ctx.roundRect === 'function') {
          ctx.beginPath();
          ctx.roundRect(x, (height - h) / 2, BAR_WIDTH, h, BAR_WIDTH / 2);
          ctx.fill();
        } else {
          ctx.fillRect(x, (height - h) / 2, BAR_WIDTH, h);
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [level, height]);

  return <canvas ref={canvasRef} aria-hidden style={{ width: '100%', height, display: 'block', color: 'inherit' }} />;
}
