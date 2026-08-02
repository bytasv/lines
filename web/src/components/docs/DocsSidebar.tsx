import { Fragment, useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Group,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tree,
  useTree,
} from '@mantine/core';
import {
  IconArrowLeft,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconHome,
  IconSearch,
} from '@tabler/icons-react';
import { searchDocs } from '@lines/shared';
import type { DocFile } from '@lines/shared';
import { ancestorDirs, toDocTreeNodes } from '../../lib/docs';

const MAX_HITS = 25;

interface DocsSidebarProps {
  docs: readonly DocFile[];
  /** Bundle-relative path of the open doc, or '' on the card home. */
  selected: string;
  query: string;
  onQueryChange: (q: string) => void;
  onSelect: (rel: string) => void;
  onHome: () => void;
  onBack: () => void;
}

/**
 * Corpus navigation: full-text search when the box has a query, the doc tree
 * otherwise. Not `FileTree` — that one lazily fetches a directory per expand,
 * while here every path is already in hand and only markdown belongs in it.
 */
export function DocsSidebar({
  docs,
  selected,
  query,
  onQueryChange,
  onSelect,
  onHome,
  onBack,
}: DocsSidebarProps) {
  // Search runs over the whole corpus on every keystroke; deferring keeps typing
  // responsive without a hand-rolled debounce.
  const deferredQuery = useDeferredValue(query);
  const hits = useMemo(
    () => searchDocs(docs, deferredQuery, MAX_HITS),
    [docs, deferredQuery],
  );
  const data = useMemo(() => toDocTreeNodes(docs.map((d) => d.path)), [docs]);

  const [expandedState, setExpandedState] = useState<Record<string, boolean>>({});
  // Reveal the open doc — including one reached by a cross-link or a reload.
  useEffect(() => {
    if (!selected) return;
    setExpandedState((e) => {
      const missing = ancestorDirs(selected).filter((dir) => !e[dir]);
      if (!missing.length) return e;
      return { ...e, ...Object.fromEntries(missing.map((dir) => [dir, true])) };
    });
  }, [selected]);

  const tree = useTree({
    selectedState: selected ? [selected] : [],
    expandedState,
    onExpandedStateChange: setExpandedState,
  });

  return (
    <Stack gap="xs" p="xs" h="100%" style={{ minHeight: 0 }}>
      <Button
        variant="subtle"
        color="gray"
        size="xs"
        justify="start"
        leftSection={<IconArrowLeft size={14} />}
        onClick={onBack}
      >
        Back to app
      </Button>
      <TextInput
        size="xs"
        placeholder="Search documentation"
        leftSection={<IconSearch size={14} />}
        value={query}
        onChange={(e) => onQueryChange(e.currentTarget.value)}
      />
      <ScrollArea style={{ flex: 1 }} type="hover">
        {deferredQuery.trim() ? (
          <Stack gap={2}>
            {hits.length === 0 ? (
              <Text size="xs" c="dimmed" p="xs">
                No matches.
              </Text>
            ) : (
              hits.map((hit) => (
                <Box
                  key={hit.path}
                  className="docs-hit"
                  p={6}
                  style={{ borderRadius: 6, cursor: 'pointer' }}
                  onClick={() => onSelect(hit.path)}
                >
                  <Text size="sm" fw={600} truncate>
                    {hit.title}
                  </Text>
                  <Text size="xs" c="dimmed" truncate>
                    {hit.path}
                  </Text>
                  {hit.matches.map((m) => (
                    <Text key={m.line} size="xs" c="dimmed" lineClamp={2} mt={2}>
                      {m.line}: <Highlight text={m.text} query={deferredQuery.trim()} />
                    </Text>
                  ))}
                </Box>
              ))
            )}
          </Stack>
        ) : (
          <>
            <NavLink
              label="Features"
              description="Index home"
              leftSection={<IconHome size={14} />}
              active={selected === ''}
              onClick={onHome}
            />
            <Tree
              data={data}
              tree={tree}
              levelOffset={14}
              renderNode={({ node, expanded, hasChildren, elementProps }) => (
                <Group
                  gap={4}
                  wrap="nowrap"
                  py={2}
                  {...elementProps}
                  style={{
                    ...elementProps.style,
                    borderRadius: 6,
                    background: elementProps['data-selected']
                      ? 'var(--mantine-color-default-hover)'
                      : undefined,
                  }}
                  onClick={(e) => {
                    elementProps.onClick(e);
                    if (!hasChildren) onSelect(node.value);
                  }}
                >
                  {hasChildren ? (
                    <>
                      <IconChevronRight
                        size={12}
                        style={{
                          flexShrink: 0,
                          transform: expanded ? 'rotate(90deg)' : undefined,
                          transition: 'transform 120ms',
                        }}
                      />
                      {expanded ? (
                        <IconFolderOpen size={14} style={{ flexShrink: 0 }} />
                      ) : (
                        <IconFolder size={14} style={{ flexShrink: 0 }} />
                      )}
                    </>
                  ) : (
                    <IconFile size={14} style={{ flexShrink: 0, marginLeft: 16 }} />
                  )}
                  <Text size="sm" truncate>
                    {node.label}
                  </Text>
                </Group>
              )}
            />
          </>
        )}
      </ScrollArea>
    </Stack>
  );
}

/** Mark every case-insensitive occurrence of `query` inside a snippet line. */
function Highlight({ text, query }: { text: string; query: string }) {
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(q); i !== -1 && q; i = lower.indexOf(q, at)) {
    parts.push(<Fragment key={`t${at}`}>{text.slice(at, i)}</Fragment>);
    parts.push(<mark key={`m${i}`}>{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  parts.push(<Fragment key="tail">{text.slice(at)}</Fragment>);
  return <>{parts}</>;
}
