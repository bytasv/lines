import { Avatar, Text, Tooltip } from '@mantine/core';
import { usePeers } from '../lib/presence';
import { useIdentityResolver } from '../lib/identity';

/**
 * Who else is in this session, in the header.
 *
 * Peers only — your own avatar says nothing you don't know. A focused peer gets a
 * ring: in a shared session the thing you actually want to know before typing is
 * whether somebody else is mid-sentence.
 *
 * Renders nothing when you are alone, which is the overwhelmingly common case, so
 * a solo session's header is exactly as it was.
 */
export function PresenceStack({ sessionId }: { sessionId: string }) {
  const peers = usePeers(sessionId);
  const identify = useIdentityResolver();
  if (peers.length === 0) return null;

  return (
    <Avatar.Group spacing="xs">
      {peers.slice(0, 4).map((peer) => {
        // The host's own presence entry carries no profile — the bridge has no
        // Clerk lookup for its own owner — so this resolves them from the grant.
        const who = identify(peer.userId, peer.profile);
        return (
          <Tooltip
            key={peer.connId}
            label={peer.focused ? `${who.name} — typing…` : `${who.name} is here`}
            withArrow
            openDelay={200}
          >
            <Avatar
              src={who.imageUrl ?? undefined}
              size={22}
              radius="xl"
              color={who.color}
              variant="filled"
              // The ring is the "probably typing" signal. Colour rather than an
              // icon, so it reads at 22px.
              style={
                peer.focused
                  ? { outline: '2px solid var(--mantine-color-teal-5)', outlineOffset: 1 }
                  : undefined
              }
            >
              <Text size="10px" fw={600}>
                {who.initials}
              </Text>
            </Avatar>
          </Tooltip>
        );
      })}
      {peers.length > 4 && (
        <Avatar size={22} radius="xl">
          <Text size="10px">+{peers.length - 4}</Text>
        </Avatar>
      )}
    </Avatar.Group>
  );
}
