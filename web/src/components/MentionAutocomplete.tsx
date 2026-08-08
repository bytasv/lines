import { useEffect, useRef, useState } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';
import {
  mentionKindMeta,
  mentionProviders,
  type MentionCandidate,
} from '../lib/mentions';

const DEBOUNCE_MS = 150;

/**
 * Debounced search across every {@link mentionProviders}. `query` null closes
 * the search (returns empty). A request-sequence guard drops stale responses so
 * fast typing never flashes an older result set.
 */
export function useMentionSearch(
  query: string | null,
  cwd: string,
  roots: string[],
): MentionCandidate[] {
  const [results, setResults] = useState<MentionCandidate[]>([]);
  const seqRef = useRef(0);
  // Callers derive `roots` per render, so the array identity churns even when the
  // roots don't; the joined string is what the effect can actually compare.
  const rootsKey = roots.join('\n');

  useEffect(() => {
    if (query === null) {
      setResults([]);
      return;
    }
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      const searchRoots = rootsKey.split('\n');
      const perProvider = await Promise.all(
        mentionProviders.map((p) => p.search(query, { cwd, roots: searchRoots }).catch(() => [])),
      );
      if (seq !== seqRef.current) return; // a newer query superseded this one
      setResults(perProvider.flat());
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, cwd, rootsKey]);

  return results;
}

/**
 * The mention popover's dropdown body: candidates grouped by kind, the active
 * row highlighted. Rendering only — keyboard/selection state lives in the composer.
 */
export function MentionDropdown({
  results,
  activeIndex,
  onSelect,
}: {
  results: MentionCandidate[];
  activeIndex: number;
  onSelect: (candidate: MentionCandidate) => void;
}) {
  if (results.length === 0) {
    return (
      <Text size="xs" c="dimmed" p="xs">
        No matches
      </Text>
    );
  }

  // Group rows by kind while keeping a flat index that matches keyboard nav.
  let flatIndex = -1;
  const kinds = [...new Set(results.map((r) => r.kind))];
  return (
    <Stack gap={2}>
      {kinds.map((kind) => {
        const meta = mentionKindMeta[kind];
        const Icon = meta?.icon;
        const rows = results.filter((r) => r.kind === kind);
        return (
          <Box key={kind}>
            <Text size="10px" c="dimmed" fw={600} px={6} py={2} tt="uppercase">
              {meta?.label ?? kind}
            </Text>
            {rows.map((r) => {
              flatIndex++;
              const idx = flatIndex;
              const active = idx === activeIndex;
              return (
                <Group
                  key={`${r.kind}:${r.id}`}
                  gap={6}
                  wrap="nowrap"
                  px={6}
                  py={4}
                  style={{
                    cursor: 'pointer',
                    borderRadius: 'var(--mantine-radius-sm)',
                    background: active ? 'var(--mantine-color-default-hover)' : undefined,
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep textarea focus
                    onSelect(r);
                  }}
                >
                  {Icon && <Icon size={14} color={`var(--mantine-color-${meta.color}-6)`} style={{ flexShrink: 0 }} />}
                  <Text size="sm" style={{ flexShrink: 0 }}>
                    {r.label}
                  </Text>
                  {r.detail && (
                    <Text size="xs" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}>
                      {r.detail}
                    </Text>
                  )}
                </Group>
              );
            })}
          </Box>
        );
      })}
    </Stack>
  );
}
