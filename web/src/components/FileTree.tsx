import { useEffect, useRef, useState } from 'react';
import { Group, Loader, Text, Tree, mergeAsyncChildren, useTree } from '@mantine/core';
import type { TreeNodeData } from '@mantine/core';
import { IconChevronRight, IconFile, IconFolder, IconFolderOpen } from '@tabler/icons-react';
import type { TreeEntry } from '@claude-ui/shared';
import { fetchTree } from '../lib/files';

interface FileTreeProps {
  /** Absolute directory the tree is rooted at (the project path). */
  root: string;
  onFileClick: (absPath: string) => void;
  /** Absolute path of the file to highlight, if any. */
  selectedPath?: string | null;
}

function toNodes(parent: string, entries: TreeEntry[]): TreeNodeData[] {
  return entries.map((e) => ({
    value: parent === '/' ? `/${e.name}` : `${parent}/${e.name}`,
    label: e.name,
    ...(e.type === 'dir' && { hasChildren: true }),
  }));
}

/** Lazily loading project file tree; each directory is fetched on first expand. */
export function FileTree({ root, onFileClick, selectedPath }: FileTreeProps) {
  const [data, setData] = useState<TreeNodeData[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTree(root)
      .then((entries) => {
        if (!cancelled) setData(toNodes(root, entries));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  const tree = useTree({
    selectedState: selectedPath ? [selectedPath] : [],
    onLoadChildren: async (value) => {
      const entries = await fetchTree(value);
      setData((d) => mergeAsyncChildren(d, value, toNodes(value, entries)));
    },
  });

  // Auto-expand and load every ancestor directory of the selected file so a
  // nested open file is revealed in the tree.
  const revealedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedPath || !selectedPath.startsWith(root + '/')) return;
    if (revealedRef.current === selectedPath) return;
    revealedRef.current = selectedPath;
    const rel = selectedPath.slice(root.length + 1);
    const segments = rel.split('/').slice(0, -1); // drop the file name
    let cancelled = false;
    (async () => {
      let dir = root;
      for (const seg of segments) {
        dir = `${dir}/${seg}`;
        try {
          const entries = await fetchTree(dir);
          if (cancelled) return;
          setData((d) => mergeAsyncChildren(d, dir, toNodes(dir, entries)));
          tree.expand(dir);
        } catch {
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, root]);

  if (error) {
    return (
      <Text size="xs" c="red" p="sm">
        {error}
      </Text>
    );
  }

  return (
    <Tree
      data={data}
      tree={tree}
      levelOffset={14}
      renderNode={({ node, expanded, hasChildren, isLoading, elementProps }) => (
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
            if (!hasChildren) onFileClick(node.value);
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
          {isLoading && <Loader size={10} />}
        </Group>
      )}
    />
  );
}
