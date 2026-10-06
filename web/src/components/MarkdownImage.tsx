import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { Text } from '@mantine/core';
import { IconExternalLink, IconPhoto } from '@tabler/icons-react';
import { markdownImageTarget } from '../lib/markdownImage';
import { useStore } from '../store';

const InLink = createContext(false);

/**
 * Wraps a markdown link's content. An image inside a link is that link's label
 * (a README badge), so the link stays the one action — the placeholder must not
 * become a second anchor nested inside the first.
 */
export function MarkdownLinkContent({ children }: { children: ReactNode }) {
  return <InLink value={true}>{children}</InLink>;
}

/** Dashed, so it reads as a slot something was not put into. Inline styles: `.md-body a` would restyle it as a link. */
const CHIP: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  maxWidth: '100%',
  padding: '0 6px',
  border: '1px dashed var(--mantine-color-default-border)',
  borderRadius: 4,
  verticalAlign: 'middle',
  fontSize: 12,
  color: 'inherit',
  textDecoration: 'none',
};

/**
 * A markdown image, shown as a placeholder and never fetched (lib/markdownImage
 * says why). The alt text and where it points stay visible — the host, for a
 * URL, so an exfiltration attempt reads as one — and the full address is in the
 * tooltip.
 *
 * A click is a deliberate navigation, not a load: a URL opens in a new tab with
 * no referrer, a file path opens in the file preview (through `onLinkClick` when
 * the host routes links itself, exactly as a link would). Loading it inline on
 * click is not on offer: the deployed CSP's `img-src` admits no arbitrary host,
 * which is this same channel closed one layer down.
 */
export function MarkdownImage({
  src,
  alt,
  onLinkClick,
}: {
  src: string | undefined;
  alt: string | undefined;
  onLinkClick?: (href: string) => void;
}) {
  const inLink = useContext(InLink);
  const target = markdownImageTarget(src, window.location.href);
  const where = target.kind === 'url' ? target.host : target.kind === 'path' ? target.path : null;
  const content = (
    <>
      <IconPhoto size={13} aria-hidden style={{ flexShrink: 0, opacity: 0.7 }} />
      <span>{alt?.trim() || 'Image'}</span>
      {where && (
        <Text span fz={11} c="dimmed" ff={target.kind === 'path' ? 'monospace' : undefined}>
          {where}
        </Text>
      )}
      {target.kind === 'url' && !inLink && (
        <IconExternalLink size={11} aria-hidden style={{ flexShrink: 0, opacity: 0.6 }} />
      )}
    </>
  );

  if (inLink || target.kind === 'none') {
    const address = target.kind === 'url' ? target.href : where;
    return (
      <span style={CHIP} title={`Image not loaded automatically${address ? `: ${address}` : ''}`}>
        {content}
      </span>
    );
  }
  if (target.kind === 'url') {
    return (
      <a
        href={target.href}
        target="_blank"
        rel="noopener noreferrer"
        style={CHIP}
        title={`Not loaded automatically. Opens ${target.href} in a new tab.`}
      >
        {content}
      </a>
    );
  }
  return (
    <a
      href="#"
      style={CHIP}
      title={`Not loaded automatically. Opens ${target.path} in the file preview.`}
      onClick={(e) => {
        e.preventDefault();
        if (onLinkClick) onLinkClick(src ?? target.path);
        else useStore.getState().openFilePreview(target.path);
      }}
    >
      {content}
    </a>
  );
}
