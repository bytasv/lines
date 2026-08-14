import { memo } from 'react';
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

const rehypePlugins: PluggableList = [
  [rehypeHighlight, { detect: false, aliases: { typescript: ['tsx', 'mts'], javascript: ['jsx', 'mjs'] } }],
  rehypeFilePaths,
  rehypeColorSwatches,
];

/**
 * GitHub Flavored Markdown is on (`remarkGfm`): tables, strikethrough, task lists,
 * footnotes, autolink literals. Table styling comes from Mantine's Typography rules
 * driven by the `.md-body` spacing vars; only overflow is handled in `index.css`.
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
  return (
    <Typography fz="sm" className="md-body">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
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
            return (
              <a href={href} {...props}>
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
