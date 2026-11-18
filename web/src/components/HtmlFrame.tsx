import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Alert, Box } from '@mantine/core';

/** Sandbox flags for the HTML preview frame. Never add `allow-same-origin`: with
 * `allow-scripts` it lets the page lift its own sandbox and reach the app. */
export const HTML_PREVIEW_SANDBOX = 'allow-scripts allow-popups allow-forms allow-modals';

/** How long the shell gets to say it is ready before the frame counts as blank. */
export const HTML_PREVIEW_READY_MS = 3000;

const FILL = { width: '100%', height: '100%', border: 0, display: 'block' } as const;

/**
 * Agent-written HTML, rendered with its scripts running. The frame loads the
 * static `/html-preview.html` shell, whose own CSP puts it in an opaque-origin
 * sandbox (deploy/docker/web-nginx.conf, desktop/src/main.ts), and the page is
 * handed to it by postMessage, so it never goes through a server. Only the
 * shell's messages from this frame are listened to, and the page is sent once.
 * Relative assets and links do not resolve: there is no file URL behind the page.
 *
 * Sized by its parent (`height` omitted) or to a height the caller picks. The
 * shell reports the written page's own height after writing it, and whenever it
 * changes, through `onContentHeight`, which is how a caller sizes the frame to
 * its content; a shell that predates those messages never calls it. The page is
 * sent once per mount, so a caller that changes `html` keys the frame.
 */
export function HtmlFrame({
  title,
  html,
  height,
  onContentHeight,
  className,
  style,
}: {
  title: string;
  html: string;
  /** The frame's height; omitted = fill the parent. */
  height?: number;
  /** The written page's own height, in CSS pixels, each time the shell reports it. */
  onContentHeight?: (height: number) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [stalled, setStalled] = useState(false);
  // Read through a ref so a caller's inline callback does not re-run the
  // listener effect, which would reset `sent` and could post the page twice.
  const onContentHeightRef = useRef(onContentHeight);
  onContentHeightRef.current = onContentHeight;

  useEffect(() => {
    let sent = false;
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame || event.source !== frame) return;
      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (data?.type === 'lines-html-preview-size') {
        if (typeof data.height === 'number' && Number.isFinite(data.height) && data.height >= 0) {
          onContentHeightRef.current?.(data.height);
        }
        return;
      }
      if (sent || data?.type !== 'lines-html-preview-ready') return;
      sent = true;
      setReady(true);
      // '*': the shell's origin is opaque, so there is no name to target. The
      // source check above is what pins the message to this frame.
      frame.postMessage({ type: 'lines-html-preview', html }, '*');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [html]);

  // An old desktop build or web image has no shell route: the SPA fallback is
  // refused as a frame, and nothing ever says it is ready.
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setStalled(true), HTML_PREVIEW_READY_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  return (
    <Box pos="relative" h={height ?? '100%'} className={className} style={style}>
      <iframe
        ref={frameRef}
        src="/html-preview.html"
        title={title}
        sandbox={HTML_PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
        style={FILL}
      />
      {stalled && !ready && (
        <Alert color="yellow" m="xs" pos="absolute" top={0} left={0} right={0}>
          Preview unavailable — update Lines or use Raw.
        </Alert>
      )}
    </Box>
  );
}
