import type { CSSProperties } from 'react';
import { Badge, Center, Group, Kbd, Stack, Text, ThemeIcon, UnstyledButton } from '@mantine/core';
import { IconFileSearch, IconMessageSearch, IconTextScan2 } from '@tabler/icons-react';
import type { SidebarSearchScope } from '../store';
import type { SessionSearchResponse } from '@lines/shared';
import { sessionRowMeta } from '../lib/format';
import { useIsPhone } from '../lib/layout';
import { MOD } from '../lib/platform';
import { useStore } from '../store';
import { HighlightedText } from './FileSearchPanel';

/**
 * Find-in-sessions results, in place of the session list while a query is
 * open: one header per session with hits, then its matching snippets. A snippet
 * click selects the session and hands the transcript a jump target.
 */
export function SessionSearchResults({
  results,
  query,
  onNavigate,
}: {
  results: SessionSearchResponse;
  query: string;
  onNavigate?: () => void;
}) {
  const sessions = useStore((s) => s.sessions);
  const selectedSessionId = useStore((s) => s.selectedSessionId);
  const jumpToTranscript = useStore((s) => s.jumpToTranscript);

  if (!results.sessions.length) {
    return (
      <Text size="xs" c="dimmed" ta="center" pt="lg">
        No matches
      </Text>
    );
  }

  return (
    <Stack gap={6} pb="sm">
      {results.sessions.map((hit) => {
        const session = sessions[hit.sessionId];
        const status = session ? sessionRowMeta(session) : null;
        return (
          <Stack key={hit.sessionId} gap={0}>
            <Group
              gap={6}
              wrap="nowrap"
              px="sm"
              py={4}
              style={{
                borderRadius: 8,
                background:
                  hit.sessionId === selectedSessionId ? 'var(--mantine-color-default-hover)' : undefined,
              }}
            >
              {status && (
                <span
                  className="status-dot"
                  style={
                    {
                      '--status-dot-color': `var(--mantine-color-${status.color}-6)`,
                      flexShrink: 0,
                    } as CSSProperties
                  }
                />
              )}
              <Text size="sm" fw={500} truncate style={{ flex: 1, minWidth: 0 }}>
                {session?.name ?? hit.sessionId}
              </Text>
              <Badge size="xs" variant="default" style={{ flexShrink: 0 }}>
                {hit.matches.length}
              </Badge>
            </Group>
            {hit.matches.map((m, i) => (
              <UnstyledButton
                key={`${m.seq}:${i}`}
                className="lines-search-row"
                pl={24}
                pr="sm"
                py={2}
                style={{ display: 'block', width: '100%', borderRadius: 6 }}
                onClick={() => {
                  jumpToTranscript(hit.sessionId, m.seq, m.toolUseId);
                  onNavigate?.();
                }}
              >
                <Text size="xs" c="dimmed" lineClamp={2} style={{ wordBreak: 'break-word' }}>
                  <HighlightedText text={m.text} query={query} />
                </Text>
              </UnstyledButton>
            ))}
          </Stack>
        );
      })}
      {results.truncated && (
        <Text size="xs" c="dimmed" ta="center">
          Showing the first matches only — refine the query to see more.
        </Text>
      )}
    </Stack>
  );
}

const PLACEHOLDER: Record<SidebarSearchScope, { icon: typeof IconFileSearch; title: string; hint: string }> =
  {
    all: {
      icon: IconMessageSearch,
      title: 'Search all sessions',
      hint: 'Prompts, replies, commands and tool output across this project.',
    },
    session: {
      icon: IconTextScan2,
      title: 'Search this session',
      hint: 'Find a line in the open transcript — even far above what is on screen.',
    },
    files: {
      icon: IconFileSearch,
      title: 'Search in files',
      hint: 'Contents of every file in the project. Click a line to open it beside the results.',
    },
  };

/** What the results area shows while the search is open and nothing is typed yet.
 *  Centres itself in whatever box it is given — the Sidebar hands it the whole
 *  area below the search controls. */
export function SearchPlaceholder({ scope }: { scope: SidebarSearchScope }) {
  const { icon: Icon, title, hint } = PLACEHOLDER[scope];
  // The shortcuts are desktop-only (see Sidebar's hotkeys), so a phone gets none.
  const isPhone = useIsPhone();
  return (
    <Center h="100%" px="md" pb={48}>
      <Stack align="center" gap={10} maw={240}>
        <ThemeIcon size={48} radius="xl" variant="light" color="gray">
          <Icon size={24} stroke={1.5} />
        </ThemeIcon>
        <Text size="sm" fw={600}>
          {title}
        </Text>
        <Text size="xs" c="dimmed" ta="center">
          {hint}
        </Text>
        {!isPhone && (
          <Stack gap={4} mt={6} align="center">
            <Group gap={6} wrap="nowrap">
              <Kbd size="xs">{MOD}</Kbd>
              <Kbd size="xs">F</Kbd>
              <Text size="xs" c="dimmed">
                sessions
              </Text>
              <Kbd size="xs">{MOD}</Kbd>
              <Kbd size="xs">⇧</Kbd>
              <Kbd size="xs">F</Kbd>
              <Text size="xs" c="dimmed">
                files
              </Text>
            </Group>
            <Group gap={6} wrap="nowrap">
              <Kbd size="xs">Esc</Kbd>
              <Text size="xs" c="dimmed">
                back to the list
              </Text>
            </Group>
          </Stack>
        )}
      </Stack>
    </Center>
  );
}
