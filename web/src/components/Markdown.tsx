import ReactMarkdown from 'react-markdown';
import { Typography } from '@mantine/core';

export function Markdown({ text }: { text: string }) {
  return (
    <Typography fz="sm" className="md-body">
      <ReactMarkdown
        components={{
          code({ className, children, ...props }) {
            const isBlock = String(className ?? '').includes('language-');
            return (
              <code
                className={className}
                style={{
                  fontSize: 12,
                  ...(isBlock
                    ? { display: 'block', overflowX: 'auto', padding: 10, borderRadius: 6 }
                    : {}),
                }}
                {...props}
              >
                {children}
              </code>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </Typography>
  );
}
