import { ActionIcon, Alert, Box, Breadcrumbs, Group, ScrollArea, Text, Tooltip } from '@mantine/core';
import { IconFileCode } from '@tabler/icons-react';
import type { DocFile } from '@lines/shared';
import { Markdown } from '../Markdown';

interface DocViewProps {
  /** Undefined when the URL names a doc this corpus doesn't hold. */
  doc: DocFile | undefined;
  rel: string;
  /** Absolute docs root, for the source preview. */
  root: string;
  onDocLink: (href: string) => void;
  onOpenSource: (abs: string) => void;
}

/** One rendered document, with its links routed back into the reader. */
export function DocView({ doc, rel, root, onDocLink, onOpenSource }: DocViewProps) {
  return (
    <Box h="100%" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Group justify="space-between" wrap="nowrap" px="lg" py="xs" gap="xs">
        <Breadcrumbs separator="/" styles={{ separator: { margin: '0 4px' } }}>
          {rel.split('/').map((seg, i, all) => (
            <Text key={`${seg}-${i}`} size="xs" c={i === all.length - 1 ? undefined : 'dimmed'}>
              {seg}
            </Text>
          ))}
        </Breadcrumbs>
        <Tooltip label="Open source">
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Open source"
            onClick={() => onOpenSource(`${root}/${rel}`)}
          >
            <IconFileCode size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <ScrollArea style={{ flex: 1, minHeight: 0 }} type="hover">
        {doc ? (
          <Box className="docs-body" px="lg" pb="xl">
            <Markdown text={doc.content} onLinkClick={onDocLink} />
          </Box>
        ) : (
          <Box px="lg" pb="xl">
            <Alert color="gray" title="Not in this corpus">
              <Text size="sm">
                {rel} is linked from the documentation but isn’t one of the markdown files under
                docs/. Open the source to check whether it exists.
              </Text>
            </Alert>
          </Box>
        )}
      </ScrollArea>
    </Box>
  );
}
