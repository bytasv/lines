import { memo, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Typography } from '@mantine/core';
import { isExternalHref } from '@lines/shared';
import { rehypeFilePaths } from '../lib/rehypeFilePaths';
import { rehypeColorSwatches } from '../lib/rehypeColorSwatches';
import { InlineColorSwatch } from './InlineColorSwatch';
import { useStore } from '../store';

const remarkPlugins: PluggableList = [remarkGfm];

const highlightPlugin: PluggableList[number] = [
  rehypeHighlight,
  { detect: false, aliases: { typescript: ['tsx', 'mts'], javascript: ['jsx', 'mjs'] } },
];

/**
 * Two plugin sets, because syntax highlighting is the expensive one and it is the
 * one nobody misses for a frame.
 *
 * Measured on a real 5540-event session, which mounts 93 of these at once on a
 * session switch: the whole set costs ~305 ms, ~190 ms of which is
 * rehype-highlight. So the first paint runs without it and an idle callback
 * upgrades the document in place — highlighting only adds `<span>`s inside a
 * `<pre>`, so the upgrade cannot reflow the transcript around it.
 */
const litePlugins: PluggableList = [rehypeFilePaths, rehypeColorSwatches];

const fullPlugins: PluggableList = [highlightPlugin, rehypeFilePaths, rehypeColorSwatches];

/**
 * Whether this document has anything for the highlighter to act on — a fence or an
 * indented block. Without one, deferring would buy a second parse for nothing, so
 * those documents go straight to the full set.
 */
function hasCodeBlock(text: string): boolean {
  return text.includes('```') || /^ {4}\S/m.test(text);
}

/**
 * GitHub Flavored Markdown is on (`remarkGfm`): tables, strikethrough, task lists,
 * footnotes, autolink literals. Tables inherit borders from Mantine's Typography;
 * `index.css` overrides the density (cell padding, font size, shrink-to-fit width).
 *
 * `onLinkClick` lets a host (the documentation reader) route links itself
 * instead of opening the source preview. Omitted — as every transcript call site
 * does — behaviour is exactly the store's `openFilePreview`. Keep it referentially
 * stable: this component is memo'd.
 */
export const Markdown = memo(function Markdown({
  text,
  onLinkClick,
}: {
  text: string;
  onLinkClick?: (href: string) => void;
}) {
  // Starts true when there is nothing to defer, so those documents render once.
  const [highlighted, setHighlighted] = useState(() => !hasCodeBlock(text));
  useEffect(() => {
    if (highlighted) return;
    // Timeout bound: a transcript that never goes idle (a long streaming turn)
    // must still end up highlighted.
    if (typeof requestIdleCallback !== 'function') {
      const t = setTimeout(() => setHighlighted(true), 200);
      return () => clearTimeout(t);
    }
    const handle = requestIdleCallback(() => setHighlighted(true), { timeout: 2000 });
    return () => cancelIdleCallback(handle);
  }, [highlighted]);

  return (
    <Typography fz="sm" className="md-body">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={highlighted ? fullPlugins : litePlugins}
        components={{
          a({ className, children, href, node, ...props }) {
            const filepath = (node?.properties?.dataFilepath as string | undefined) ?? undefined;
            if (String(className ?? '').includes('file-link') && filepath) {
              return (
                <a
                  className={className}
                  href="#"
                  style={{ cursor: 'pointer' }}
                  onClick={(e) => {
                    e.preventDefault();
                    if (onLinkClick) onLinkClick(filepath);
                    else useStore.getState().openFilePreview(filepath);
                  }}
                >
                  {children}
                </a>
              );
            }
            if (onLinkClick && href && !isExternalHref(href)) {
              return (
                <a
                  href="#"
                  style={{ cursor: 'pointer' }}
                  onClick={(e) => {
                    e.preventDefault();
                    onLinkClick(href);
                  }}
                >
                  {children}
                </a>
              );
            }
            // External links open a new tab: in the desktop window an in-place
            // navigation has no way back, and in a browser it costs the user
            // their live session tab. Scoped to external hrefs so `remark-gfm`'s
            // footnote anchors (#user-content-fn-1) stay in-page.
            const external = href ? isExternalHref(href) : false;
            return (
              <a
                href={href}
                {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
                {...props}
              >
                {children}
              </a>
            );
          },
          span({ className, children, node, ...props }) {
            const color = (node?.properties?.dataColor as string | undefined) ?? undefined;
            if (String(className ?? '').includes('color-chip') && color) {
              return <InlineColorSwatch color={color} />;
            }
            return (
              <span className={className} {...props}>
                {children}
              </span>
            );
          },
          // Wrapper scrolls a too-wide table instead of widening the conversation column.
          table({ children, node, ...props }) {
            return (
              <div className="md-table-wrap">
                <table {...props}>{children}</table>
              </div>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </Typography>
  );
});
