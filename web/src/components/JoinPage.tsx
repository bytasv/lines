import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SignedIn, SignedOut, SignIn, useAuth } from '@clerk/clerk-react';
import { Alert, Avatar, Button, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { PRESET_COPY, claimInvite, invitePreview, type InvitePreview } from '../lib/shares';
import { useDevices } from '../lib/devices';
import { rememberDeviceId, setStorageTokenProvider } from '../lib/storage';
import { adoptJoinGrant, pendingJoinGrantDevice, takeJoinGrantFromUrl } from '../lib/e2ee';
import { setTokenProvider, switchDevice } from '../ws';
import { GateHint, GateShell } from './GateShell';

/**
 * `/join/:code` — redeeming an invite, including for someone with no account yet.
 *
 * Signed out, this page says nothing about who invited them or to what: a link
 * can be forwarded or leaked, and the holder is not yet known to be the invitee.
 * The real preview needs a signed-in identity, which is also what the claim is
 * checked against.
 */
export function JoinPage() {
  const { code = '' } = useParams();

  // Belt and braces on the auth round trip: sessionStorage survives a redirect
  // that drops the path, and Clerk is also told to come back here. OAuth
  // providers have been known to lose query params, and an invite that vanishes
  // during sign-up is unrecoverable for the invitee.
  useEffect(() => {
    if (code) sessionStorage.setItem('lines.joinCode', code);
    // The machine's grant rides in the fragment, which the sign-in round trip
    // drops just as it may drop the path — so it is stashed beside the code and
    // stripped from the address bar at once.
    if (code) takeJoinGrantFromUrl(code);
  }, [code]);

  return (
    <>
      <SignedOut>
        <GateShell>
          <Stack align="center" gap="md" maw={420}>
            <Title order={4}>You’ve been invited to collaborate on Lines</Title>
            <GateHint>
              Sign in or create an account to see the invitation. Lines runs coding agents on your
              own computer — an invite lets you work on somebody else’s.
            </GateHint>
            {/* Every route back here, because a provider that drops one still has
                the others (and sessionStorage above). */}
            <SignIn
              routing="virtual"
              signUpUrl={`/join/${code}`}
              forceRedirectUrl={`/join/${code}`}
              fallbackRedirectUrl={`/join/${code}`}
            />
          </Stack>
        </GateShell>
      </SignedOut>
      <SignedIn>
        <JoinPreview code={code} />
      </SignedIn>
    </>
  );
}

function JoinPreview({ code }: { code: string }) {
  const { getToken, isLoaded } = useAuth();
  // Registered here, not left to AuthedConnect: this route deliberately sits
  // outside the device gate (an invitee may have no machine, and the signed-out
  // half must render), so the component that normally installs the token source
  // never mounts. Without this every call below goes out with no Authorization
  // header and storage answers 401 — which surfaced as "unauthenticated" on an
  // invitation that was perfectly valid.
  //
  // Assigned during render for the same reason AuthedConnect does it: this
  // component's own effect fires immediately after, and an effect-based
  // registration would lose the race with it.
  setStorageTokenProvider(() => getToken());
  // And the socket's, for the same reason: `accept()` below calls switchDevice()
  // before navigating, so the dial happens while AuthedConnect is still
  // unmounted. Unset, the relay refuses it 1008 and the link only recovers on the
  // 5s unauthorized-retry — a stall with no explanation on screen.
  setTokenProvider(() => getToken());
  const navigate = useNavigate();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isLoaded || !code) return;
    invitePreview(code)
      .then(setPreview)
      .catch((err: Error) => setError(err.message));
  }, [code, isLoaded]);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const { deviceId } = await claimInvite(code);
      sessionStorage.removeItem('lines.joinCode');
      // Now that the claim has named the machine: the token to present there and
      // the key to hold the channel to. Without them that machine admits nobody.
      adoptJoinGrant(deviceId, code);
      // Point this browser at the machine we were just given, then let the device
      // gate do the connecting — the same path "Use this" in Settings takes.
      // Awaited, so the gate sees the new machine in the list before we select it.
      await useDevices.getState().refresh();
      rememberDeviceId(deviceId);
      switchDevice(deviceId);
      navigate('/');
    } catch (err) {
      // Already claimed — by this account, from another browser, or before site
      // data was cleared — is a share this account already holds, and what this
      // browser lacks is only the link's grant. Taken up here rather than leaving
      // the guest with a machine that refuses them and an invite that is spent.
      const device = pendingJoinGrantDevice();
      if (device) {
        await useDevices.getState().refresh();
        const held = (useDevices.getState().devices ?? []).some((d) => d.id === device && d.shared);
        if (held && adoptJoinGrant(device, code)) {
          sessionStorage.removeItem('lines.joinCode');
          rememberDeviceId(device);
          switchDevice(device);
          navigate('/');
          return;
        }
      }
      // Includes the email-mismatch case, which storage answers with the invited
      // address named — the likeliest real failure, and unexplainable as a bare
      // "unauthorized".
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  if (error) {
    return (
      <GateShell>
        <Stack align="center" gap="md" maw={460}>
          <Title order={4}>This invitation can’t be used</Title>
          <Alert color="red" variant="light">
            {error}
          </Alert>
          <Button variant="light" onClick={() => navigate('/')}>
            Go to Lines
          </Button>
        </Stack>
      </GateShell>
    );
  }

  if (!preview) {
    return (
      <GateShell>
        <Loader />
      </GateShell>
    );
  }

  if (preview.isOwn) {
    return (
      <GateShell>
        <Stack align="center" gap="md" maw={420}>
          <Title order={4}>This is your own invitation</Title>
          <GateHint>Send the link to the person you want to share with.</GateHint>
          <Button variant="light" onClick={() => navigate('/')}>
            Go to Lines
          </Button>
        </Stack>
      </GateShell>
    );
  }

  const who = preview.owner?.name ?? preview.owner?.email ?? 'Someone';
  return (
    <GateShell>
      <Stack align="center" gap="md" maw={460}>
        <Group gap="xs">
          <Avatar src={preview.owner?.imageUrl ?? undefined} radius="xl" size={32}>
            {who.slice(0, 1).toUpperCase()}
          </Avatar>
          <Title order={4}>{who} invited you</Title>
        </Group>
        <GateHint>
          {preview.scope === 'session'
            ? `To the session “${preview.sessionName ?? 'untitled'}” on ${preview.machineName ?? 'their machine'}.`
            : `To their machine ${preview.machineName ?? ''}.`}
        </GateHint>
        {preview.preset && (
          // Named before accepting, so a guest knows what they may do rather than
          // discovering it by clicking something that refuses.
          <Stack align="center" gap={2}>
            <Text size="sm" fw={500}>
              {PRESET_COPY[preview.preset].label}
            </Text>
            <Text size="xs" c="dimmed" ta="center">
              {PRESET_COPY[preview.preset].detail}
            </Text>
          </Stack>
        )}
        <Text size="xs" c="dimmed" ta="center">
          Anything you run happens on {who}’s computer, as them. They can revoke this at any time.
        </Text>
        <Group>
          <Button onClick={() => void accept()} loading={busy}>
            Accept
          </Button>
          <Button variant="subtle" color="gray" onClick={() => navigate('/')}>
            Not now
          </Button>
        </Group>
      </Stack>
    </GateShell>
  );
}
