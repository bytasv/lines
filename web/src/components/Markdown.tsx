import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { PluggableList } from 'unified';
import rehypeHighlight from 'rehype-highlight';
import { Typography } from '@mantine/core';
import { rehypeFilePaths } from '../lib/rehypeFilePaths';
import { useStore } from '../store';

const rehypePlugins: PluggableList = [
  [rehypeHighlight, { detect: false, aliases: { typescript: ['tsx', 'mts'], javascript: ['jsx', 'mjs'] } }],
  rehypeFilePaths,
];

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <Typography fz="sm" className="md-body">
      <ReactMarkdown
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
                    useStore.getState().openFilePreview(filepath);
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
        }}
      >
        {text}
      </ReactMarkdown>
    </Typography>
  );
});
