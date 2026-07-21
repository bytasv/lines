import { useCallback, useEffect, useRef, useState } from 'react';
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

/** Whether `value`'s children have already been loaded into the tree data. */
function hasLoadedChildren(nodes: TreeNodeData[], value: string): boolean {
  for (const node of nodes) {
    if (node.value === value) return Array.isArray(node.children);
    if (node.children && value.startsWith(node.value + '/')) {
      return hasLoadedChildren(node.children, value);
    }
  }
  return false;
}

/** Lazily loading project file tree; each directory is fetched on first expand. */
export function FileTree({ root, onFileClick, selectedPath }: FileTreeProps) {
  const [data, setData] = useState<TreeNodeData[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Controlled expanded state: reveal uses functional updates so sequential
  // ancestor expansions accumulate instead of clobbering one another.
  const [expandedState, setExpandedState] = useState<Record<string, boolean>>({});
  // Mirror of `data` for synchronous reads inside the async reveal loop.
  const dataRef = useRef<TreeNodeData[]>(data);
  dataRef.current = data;

  const tree = useTree({
    selectedState: selectedPath ? [selectedPath] : [],
    expandedState,
    onExpandedStateChange: setExpandedState,
    onLoadChildren: async (value) => {
      const entries = await fetchTree(value);
      setData((d) => mergeAsyncChildren(d, value, toNodes(value, entries)));
    },
  });

  // Load, merge, and expand every ancestor directory of `filePath` in order,
  // so a nested file is revealed. Sequential so each parent exists before its
  // child is merged.
  const revealPath = useCallback(
    async (filePath: string, isCancelled: () => boolean) => {
      const segments = filePath.slice(root.length + 1).split('/').slice(0, -1);
      let dir = root;
      for (const seg of segments) {
        dir = `${dir}/${seg}`;
        const parent = dir;
        // Already-loaded dirs need no re-fetch/merge — that would swap `data`
        // identity and make the whole tree flicker. Only ensure it's expanded.
        if (hasLoadedChildren(dataRef.current, parent)) {
          setExpandedState((e) => (e[parent] ? e : { ...e, [parent]: true }));
          continue;
        }
        try {
          const entries = await fetchTree(parent);
          if (isCancelled()) return;
          setData((d) => mergeAsyncChildren(d, parent, toNodes(parent, entries)));
          setExpandedState((e) => (e[parent] ? e : { ...e, [parent]: true }));
        } catch {
          return;
        }
      }
    },
    [root],
  );

  const revealedRef = useRef<string | null>(null);

  // Load the root, then reveal the initially-selected file.
  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    (async () => {
      try {
        const rootEntries = await fetchTree(root);
        if (cancelled) return;
        setData(toNodes(root, rootEntries));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        return;
      }
      revealedRef.current = selectedPath ?? null;
      if (selectedPath && selectedPath.startsWith(root + '/')) {
        await revealPath(selectedPath, isCancelled);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // Reveal a newly-selected file without reloading the whole tree.
  useEffect(() => {
    if (!selectedPath || !selectedPath.startsWith(root + '/')) return;
    if (revealedRef.current === selectedPath) return;
    revealedRef.current = selectedPath;
    let cancelled = false;
    void revealPath(selectedPath, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [selectedPath, root, revealPath]);

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
