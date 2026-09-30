import { Fragment, useEffect, useMemo, useRef } from 'react';
import { ActionIcon, Badge, Group, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconFile } from '@tabler/icons-react';
import type { GrepHit, MatchOptions } from '@lines/shared';
import { buildMatcher, rootsForCwd } from '@lines/shared';
import { useStore } from '../store';
import { grepFiles } from '../lib/files';

const DEBOUNCE_MS = 250;

/**
 * `text` with every match of `query` wrapped in a <mark>. The matcher is the
 * bridge's own ({@link buildMatcher}), so what is highlighted is exactly what
 * matched; an invalid regex just highlights nothing.
 */
export function HighlightedText({ text, query, opts }: { text: string; query: string; opts?: MatchOptions }) {
  const ranges = useMemo(() => {
    try {
      return buildMatcher(query, opts)(text);
    } catch {
      return [];
    }
  }, [text, query, opts]);
  if (!ranges.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], i) => {
    if (start > at) parts.push(<Fragment key={`t${i}`}>{text.slice(at, start)}</Fragment>);
    parts.push(
      <mark key={`m${i}`} className="lines-search-mark">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < text.length) parts.push(<Fragment key="tail">{text.slice(at)}</Fragment>);
  return <>{parts}</>;
}

/** One of the Aa / ab / .* toggles beside the query field. */
export function FlagToggle({
  label,
  tip,
  on,
  onToggle,
}: {
  label: string;
  tip: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip label={tip} openDelay={300}>
      <ActionIcon
        size="sm"
        variant={on ? 'filled' : 'subtle'}
        color="gray"
        aria-pressed={on}
        aria-label={tip}
        // Keep focus in the query field, so typing continues after a click.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggle}
      >
        <Text size="10px" fw={700} ff="monospace">
          {label}
        </Text>
      </ActionIcon>
    </Tooltip>
  );
}

/**
 * The sidebar search's Files scope: content matches across the active project's
 * roots, laid out like the session results — one header per file, then its
 * matching lines. A click opens the file at that line in the main pane, beside
 * the results rather than instead of them.
 */
export function FileSearchResults({ query, onNavigate }: { query: string; onNavigate?: () => void }) {
  const projects = useStore((s) => s.projects);
  const activeProject = useStore((s) => s.activeProject);
  const search = useStore((s) => s.fileSearch);
  const setSearch = useStore((s) => s.setFileSearch);
  const hideIgnored = useStore((s) => s.hideIgnored);
  const preview = useStore((s) => s.searchPreview);
  const setSearchPreview = useStore((s) => s.setSearchPreview);
  const seqRef = useRef(0);

  // Same roots as Cmd+P, primary first.
  const roots = activeProject ? rootsForCwd(projects, activeProject) : [];
  const rootsKey = roots.join('\n');
  const { caseSensitive, regex, wholeWord } = search;
  const opts = useMemo(() => ({ caseSensitive, regex, wholeWord }), [caseSensitive, regex, wholeWord]);

  // What a reply to the current inputs would answer. Results for anything else
  // (an earlier keystroke, other flags, another project) are hidden, not shown
  // until they are replaced.
  const key = JSON.stringify([query, rootsKey, caseSensitive, regex, wholeWord, hideIgnored]);

  // Debounced, with a sequence guard so a slow reply can't overwrite a newer one.
  useEffect(() => {
    const seq = ++seqRef.current;
    if (!query || !rootsKey) {
      setSearch({ results: null, resultsFor: '', loading: false, error: null });
      return;
    }
    const timer = setTimeout(async () => {
      setSearch({ loading: true });
      try {
        const results = await grepFiles(rootsKey.split('\n'), query, { ...opts, includeIgnored: !hideIgnored });
        if (seq !== seqRef.current) return;
        setSearch({ results, resultsFor: key, loading: false, error: null });
      } catch (err) {
        if (seq !== seqRef.current) return;
        setSearch({
          results: null,
          resultsFor: key,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `key` is derived from the listed inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, opts, rootsKey, hideIgnored, setSearch]);
  const current = search.resultsFor === key;

  if (!roots.length) {
    return (
      <Text size="xs" c="dimmed" ta="center" pt="lg">
        No active project
      </Text>
    );
  }
  if (!current) return null;
  if (search.error) {
    return (
      <Text size="xs" c="red" px="sm" pt="xs">
        {search.error}
      </Text>
    );
  }
  const files = search.results?.files;
  if (!files) return null;
  if (!files.length) {
    return (
      <Text size="xs" c="dimmed" ta="center" pt="lg">
        No matches
      </Text>
    );
  }

  const open = (hit: GrepHit, line: number, col: number) => {
    setSearchPreview({ path: `${hit.root}/${hit.rel}`, line, col });
    onNavigate?.();
  };

  return (
    <Stack gap={6} pb="sm">
      {files.map((hit) => {
        const path = `${hit.root}/${hit.rel}`;
        const name = hit.rel.split('/').pop() ?? hit.rel;
        const dir = hit.rel.slice(0, hit.rel.length - name.length - 1);
        const rootLabel = hit.root === roots[0] ? '' : (hit.root.split('/').filter(Boolean).pop() ?? hit.root);
        return (
          <Stack key={path} gap={0}>
            <Group
              gap={6}
              wrap="nowrap"
              px="sm"
              py={4}
              style={{
                borderRadius: 8,
                background: preview?.path === path ? 'var(--mantine-color-default-hover)' : undefined,
              }}
            >
              <IconFile size={13} color="var(--mantine-color-blue-6)" style={{ flexShrink: 0 }} />
              <Text size="sm" fw={500} style={{ flexShrink: 0 }}>
                {name}
              </Text>
              <Text size="xs" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }} title={hit.rel}>
                {rootLabel ? `${rootLabel}: ${dir}` : dir}
              </Text>
              <Badge size="xs" variant="default" style={{ flexShrink: 0 }}>
                {hit.matches.length}
              </Badge>
            </Group>
            {hit.matches.map((m) => {
              const selected = preview?.path === path && preview.line === m.line;
              return (
                <UnstyledButton
                  key={m.line}
                  className="lines-search-row"
                  pl={24}
                  pr="sm"
                  py={2}
                  onClick={() => open(hit, m.line, m.col)}
                  style={{
                    display: 'flex',
                    gap: 6,
                    width: '100%',
                    borderRadius: 6,
                    background: selected ? 'var(--mantine-color-default-hover)' : undefined,
                  }}
                >
                  <Text size="xs" c="dimmed" ff="monospace" style={{ flexShrink: 0 }}>
                    {m.line}
                  </Text>
                  <Text size="xs" c="dimmed" lineClamp={2} ff="monospace" style={{ wordBreak: 'break-word', minWidth: 0 }}>
                    <HighlightedText text={m.text} query={query} opts={opts} />
                  </Text>
                </UnstyledButton>
              );
            })}
          </Stack>
        );
      })}
      {search.results?.truncated && (
        <Text size="xs" c="dimmed" ta="center">
          Showing the first matches only — refine the query to see more.
        </Text>
      )}
    </Stack>
  );
}
