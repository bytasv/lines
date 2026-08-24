import { Avatar, Text, Tooltip } from '@mantine/core';
import type { Actor } from '@lines/shared';
import { useIdentityResolver } from '../lib/identity';

/**
 * The avatar beside a user prompt.
 *
 * Rendered for *every* prompt, solo sessions included: the alternative is an
 * avatar that appears only once a session is shared, which makes the transcript
 * change shape under the user. Consecutive prompts are never collapsed either —
 * agent output interleaves between nearly every pair, so a missing avatar would
 * read as ambiguity rather than as grouping.
 *
 * `actor` is absent on rows written before sharing existed and on the owner's own
 * prompts. Both mean the same thing — the session's host sent it — so passing a
 * null id through the resolver lands on the host (or on you, when it is your own
 * machine). A pure read-side reinterpretation, with no migration.
 */
export function PromptAuthor({ actor, ts }: { actor?: Actor; ts: number }) {
  const identify = useIdentityResolver();
  const who = identify(actor?.userId, actor);

  const when = new Date(ts).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Tooltip
      // multiline + pre-line is the idiom already used by ProjectTab, rather than
      // introducing HoverCard as a new pattern for one surface.
      label={`${who.name}${who.self ? ' (you)' : ''}\n${when}`}
      multiline
      withArrow
      openDelay={250}
      styles={{ tooltip: { whiteSpace: 'pre-line' } }}
    >
      <Avatar
        src={who.imageUrl ?? undefined}
        size={22}
        radius="xl"
        color={who.color}
        variant="filled"
        // Outside the bubble Paper, so the 80% width cap is unaffected.
        style={{ flexShrink: 0, alignSelf: 'flex-end' }}
      >
        <Text size="10px" fw={600}>
          {who.initials}
        </Text>
      </Avatar>
    </Tooltip>
  );
}
