import { useEffect, useState } from 'react';
import { Box, Group, Text } from '@mantine/core';
import { PROPOSE_UI_TOOL } from '@lines/shared';
import { agentMeta, MAIN_AGENT_META } from '../lib/agents';
import type { LiveActivity } from '../lib/transcript';
import { clearActivity, recordActivity } from '../lib/activityHandoff';
import { CrossfadeLine } from './CrossfadeLine';
import { ShimmerText } from './ShimmerText';
import { Reveal } from './Reveal';

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
      // Lines' own mock tool reads as what it is doing, not as its MCP name.
      if (live.toolName === PROPOSE_UI_TOOL) return 'Drawing UI mocks…';
      return `Preparing ${live.toolName ?? 'tool'}…`;
    }
    default:
      return 'Responding…';
  }
}

/**
 * The step row's text: one word for "busy, nothing to name yet". Working,
 * thinking and responding read the same to a user, and swapping between them is
 * the flicker the row exists to avoid. A tool being prepared is still named.
 */
function stepLabel(live: LiveActivity | null): string {
  return live?.phase === 'tool-prep' ? label(live) : 'Thinking…';
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
  text,
  step,
  sessionId,
}: {
  /** ms epoch of turn start (SessionMeta.turnStartedAt or last user event ts). */
  startedAt?: number;
  live: LiveActivity | null;
  /** ms epoch of the last server event for this session; drives the no-output warning. */
  lastEventAt?: number;
  /** Phase text to show instead of the one derived from `live` (the plan side-chat's). */
  text?: string;
  /**
   * Render as a checklist step row (TurnChecklist's in-progress row): same icon
   * column, size and padding, so when the turn card replaces this row only the
   * text changes. The main transcript uses this; the plan side-chat does not.
   */
  step?: boolean;
  /** Step mode: the session whose transcript this row is in, for the hand-off
   *  to the checklist row that replaces it (lib/activityHandoff). */
  sessionId?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsed = startedAt != null ? Math.max(0, Math.round((now - startedAt) / 1000)) : null;
  const quiet = lastEventAt != null ? Math.round((now - lastEventAt) / 1000) : null;
  // Same map the settled Agent card reads, so a running agent and the card that
  // replaces it name it identically. Only the glyph is shared: the icon stays
  // dimmed like the rest of the transcript's icons, and the shimmer on the phase
  // text is the liveness cue. The main agent stays unnamed: the session *is* the
  // main agent, so a "Claude:" prefix on every row is noise.
  const agent = live?.subagent ? agentMeta(live.subagentType) : live ? MAIN_AGENT_META : null;
  const named = Boolean(live?.subagent);
  const quietNote = quiet != null && quiet > QUIET_WARN_S && (
    <Text span size="sm" c={quiet > QUIET_ALARM_S ? 'orange' : 'dimmed'}>
      {` · no output for ${quiet}s`}
    </Text>
  );
  const glyph = (agent ?? MAIN_AGENT_META).icon;
  const stepText = `${named && agent ? `${agent.label}: ` : ''}${text ?? stepLabel(live)}`;
  const suffix = elapsed != null ? ` · ${elapsed}s` : '';
  // What this row shows, as of every commit: the checklist row that replaces it
  // starts on the same text and glyph and crossfades from them.
  useEffect(() => {
    if (step && sessionId) recordActivity(sessionId, { label: stepText, suffix, glyph });
  });
  useEffect(() => {
    if (!step || !sessionId) return;
    return () => clearActivity(sessionId);
  }, [step, sessionId]);

  if (step) {
    const StepAgentIcon = glyph;
    // Markup mirrors TurnChecklist's in-progress row exactly (slot, icon, text
    // size, padding): the row that replaces this one starts on this same glyph
    // and text and crossfades them to its own, so nothing else moves. A new
    // phase ("Thinking…" → "Preparing Bash…") crossfades here too; the seconds
    // tick in place. The shimmer is clock-synced, so its sweep runs on through
    // every swap.
    return (
      <Reveal on>
        <Group className="tx-row tx-step tx-static" gap="xs" wrap="nowrap">
          <span className="tx-step-slot">
            <span className="tx-step-icon tx-step-icon-agent">
              <StepAgentIcon size={15} />
            </span>
          </span>
          <Text size="sm" c="dimmed" component="div" style={{ minWidth: 0, flex: 1 }}>
            <CrossfadeLine
              value={{ label: stepText, suffix }}
              same={(a, b) => a.label === b.label}
              render={(v, current) => (
                <>
                  <ShimmerText>{v.label}</ShimmerText>
                  {v.suffix}
                  {current && quietNote}
                </>
              )}
            />
          </Text>
        </Group>
      </Reveal>
    );
  }

  return (
    <Group align="flex-start" gap="xs" wrap="nowrap">
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
          {agent && (
            <Text span size="sm">
              <agent.icon size={13} style={{ verticalAlign: '-2px' }} />
              {named ? ` ${agent.label}: ` : ' '}
            </Text>
          )}
          <span className="lines-shimmer-text">{text ?? label(live)}</span>
          {elapsed != null ? ` · ${elapsed}s` : ''}
          {quietNote}
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
