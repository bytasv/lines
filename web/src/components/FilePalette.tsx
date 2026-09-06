import { useEffect, useRef, useState } from 'react';
import { Box, Group, Modal, Stack, Switch, Text, TextInput } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { IconFile, IconSearch } from '@tabler/icons-react';
import { rootsForCwd } from '@lines/shared';
import { useStore } from '../store';
import { searchFiles } from '../lib/files';

const DEBOUNCE_MS = 120;
const MAX_RESULTS = 20;
const LIST_MAX_HEIGHT = 360;

type Hit = { root: string; rel: string };

/**
 * Cmd/Ctrl+P quick-open. The ranking is the bridge's (`/find` →
 * `searchFilesAcross`), the same one behind the composer's `@mention` file list,
 * so a query that finds a file in one finds it in the other — including the
 * fuzzy forms (`mntinpt`, `mention input`).
 *
 * A hit opens in the preview overlay rather than a files-mode tab: the palette
 * is reachable mid-session and from the docs reader, and neither should lose its
 * main pane to a file.
 */
export function FilePalette() {
  const projects = useStore((s) => s.projects);
  const activeProject = useStore((s) => s.activeProject);
  const openFilePreview = useStore((s) => s.openFilePreview);
  // Shared with the sidebar tree — one "Hide ignored" choice, not two.
  const hideIgnored = useStore((s) => s.hideIgnored);
  const setHideIgnored = useStore((s) => s.setHideIgnored);
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const seqRef = useRef(0);
  const rowsRef = useRef<(HTMLDivElement | null)[]>([]);

  // Every root of the project tab you are on, primary first — what the sidebar
  // tree and `@mention` already search.
  const roots = activeProject ? rootsForCwd(projects, activeProject) : [];
  // Derived per render, so the array identity churns even when the roots don't;
  // the joined string is what an effect can actually compare.
  const rootsKey = roots.join('\n');

  // A guest, or the folder picker before any project is open, has nothing to
  // search: leave Cmd+P to the browser instead of opening an empty palette.
  useHotkeys(
    [['mod+P', () => rootsKey && setOpened(true), { preventDefault: Boolean(rootsKey) }]],
    [], // no tag is ignored — the shortcut has to work from the composer textarea too
    true,
  );

  const close = () => {
    setOpened(false);
    setQuery('');
    setHits([]);
    setActive(0);
    seqRef.current++; // drop whatever is in flight, so a late reply can't repopulate
  };

  const choose = (hit: Hit) => {
    // Absolute, always: the preview resolves a relative path against the selected
    // session's cwd, and the palette is usable with no session selected at all.
    openFilePreview(`${hit.root}/${hit.rel}`);
    close();
  };

  // Debounced search with a request-sequence guard, so fast typing never flashes
  // an older result set.
  useEffect(() => {
    if (!opened) return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      return;
    }
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      const files = await searchFiles(rootsKey.split('\n'), q, MAX_RESULTS, !hideIgnored).catch(
        () => [],
      );
      if (seq !== seqRef.current) return; // a newer keystroke superseded this one
      setHits(files);
      setActive(0);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [opened, query, rootsKey, hideIgnored]);

  useEffect(() => {
    rowsRef.current[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, hits]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && hits[active]) {
      e.preventDefault();
      choose(hits[active]);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      withCloseButton={false}
      padding="xs"
      size="lg"
      yOffset="12vh"
    >
      <TextInput
        data-autofocus
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        placeholder="Search files by name"
        leftSection={<IconSearch size={15} />}
        variant="unstyled"
        size="md"
      />
      {/* Status on the left, toggle on the right, one row that is always there —
          the toggle must not vanish the moment you start typing. Mouse-down
          default is suppressed so toggling never pulls focus out of the query
          field; arrows and Enter have to keep working after a click. */}
      <Group
        justify="space-between"
        wrap="nowrap"
        gap="sm"
        px="xs"
        py={4}
        onMouseDown={(e) => e.preventDefault()}
      >
        <Text size="xs" c="dimmed" lineClamp={1}>
          {query.trim() === ''
            ? 'Type part of a file name — characters may be scattered (`mntinpt`).'
            : hits.length === 0
              ? 'No matches'
              : ''}
        </Text>
        <Switch
          size="xs"
          checked={hideIgnored}
          onChange={(e) => setHideIgnored(e.currentTarget.checked)}
          style={{ flexShrink: 0 }}
          label={
            <Text size="xs" c="dimmed">
              Hide ignored
            </Text>
          }
        />
      </Group>
      <Box style={{ maxHeight: LIST_MAX_HEIGHT, overflowY: 'auto' }}>
        {hits.length > 0 && (
          <Stack gap={2}>
            {hits.map((hit, i) => {
              const name = hit.rel.split('/').pop() ?? hit.rel;
              const dir = hit.rel.slice(0, hit.rel.length - name.length - 1);
              // Which root a hit came from only matters when there is more than
              // one, and the primary is the unmarked default.
              const rootLabel =
                hit.root === roots[0] ? '' : (hit.root.split('/').filter(Boolean).pop() ?? hit.root);
              return (
                <Group
                  key={`${hit.root}/${hit.rel}`}
                  ref={(el) => {
                    rowsRef.current[i] = el;
                  }}
                  gap={6}
                  wrap="nowrap"
                  px={6}
                  py={4}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(hit)}
                  style={{
                    cursor: 'pointer',
                    borderRadius: 'var(--mantine-radius-sm)',
                    background: i === active ? 'var(--mantine-color-default-hover)' : undefined,
                  }}
                >
                  <IconFile
                    size={14}
                    color="var(--mantine-color-blue-6)"
                    style={{ flexShrink: 0 }}
                  />
                  <Text size="sm" style={{ flexShrink: 0 }}>
                    {name}
                  </Text>
                  <Text size="xs" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}>
                    {rootLabel ? `${rootLabel}: ${dir}` : dir}
                  </Text>
                </Group>
              );
            })}
          </Stack>
        )}
      </Box>
    </Modal>
  );
}
