import { useEffect, useState } from 'react';
import { Box, Group, Loader, Text } from '@mantine/core';
import { agentMeta, MAIN_AGENT_META } from '../lib/agents';
import type { LiveActivity } from '../lib/transcript';

/** Seconds of silence before the row starts warning about missing output. */
const QUIET_WARN_S = 30;
/** Seconds of silence after which the warning turns orange. */
const QUIET_ALARM_S = 120;

/** The phase text alone — the agent it belongs to is rendered as a badge prefix. */
function label(live: LiveActivity | null): string {
  if (!live) return 'Working…';
  switch (live.phase) {
    case 'thinking':
      return 'Thinking…';
    case 'tool-prep': {
      if (live.toolName === 'ExitPlanMode') {
        const kb = live.inputBytes && live.inputBytes >= 2048 ? ` · ${Math.round(live.inputBytes / 1024)}kB` : '';
        return `Writing plan…${kb}`;
      }
      return `Preparing ${live.toolName ?? 'tool'}…`;
    }
    default:
      return 'Responding…';
  }
}

/**
 * Standalone "agent is working" row shown while a turn is running and nothing
 * else on the transcript tail indicates liveness. Owns a 1s ticker so only
 * this row re-renders per second.
 */
export function ActivityRow({
  startedAt,
  live,
  lastEventAt,
}: {
  /** ms epoch of turn start (SessionMeta.turnStartedAt or last user event ts). */
  startedAt?: number;
  live: LiveActivity | null;
  /** ms epoch of the last server event for this session; drives the no-output warning. */
  lastEventAt?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsed = startedAt != null ? Math.max(0, Math.round((now - startedAt) / 1000)) : null;
  const quiet = lastEventAt != null ? Math.round((now - lastEventAt) / 1000) : null;
  // Same map the settled Agent card reads, so a running agent and the card that
  // replaces it name it identically. The main agent shares the glyph but not the
  // colour, so who is working reads before the text does — and it stays unnamed:
  // the session *is* the main agent, so a "Claude:" prefix on every row is noise.
  const agent = live?.subagent ? agentMeta(live.subagentType) : live ? MAIN_AGENT_META : null;
  const named = Boolean(live?.subagent);

  return (
    <Group align="flex-start" gap="xs" wrap="nowrap">
      <Loader size={14} style={{ marginTop: 5, flexShrink: 0 }} />
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
          {agent && (
            <Text span size="sm" c={agent.color}>
              <agent.icon size={13} style={{ verticalAlign: '-2px' }} />
              {named ? ` ${agent.label}: ` : ' '}
            </Text>
          )}
          {label(live)}
          {elapsed != null ? ` · ${elapsed}s` : ''}
          {quiet != null && quiet > QUIET_WARN_S && (
            <Text span size="sm" c={quiet > QUIET_ALARM_S ? 'orange' : 'dimmed'}>
              {` · no output for ${quiet}s`}
            </Text>
          )}
        </Text>
        {live?.phase === 'thinking' && live.thinkingPreview && (
          <Text size="xs" c="dimmed" fs="italic" lineClamp={2}>
            {live.thinkingPreview}
          </Text>
        )}
      </Box>
    </Group>
  );
}
