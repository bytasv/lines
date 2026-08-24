import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Avatar,
  Button,
  Divider,
  Group,
  Loader,
  Modal,
  Radio,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconAlertTriangle, IconTrash } from '@tabler/icons-react';
import type { SharePreset } from '@lines/shared';
import {
  PRESET_COPY,
  createInvite,
  joinUrl,
  listShares,
  revokeGrant,
  revokeInvite,
  setGrantPreset,
  type ShareGrant,
  type ShareInvite,
} from '../lib/shares';

/**
 * Share one session, or a whole machine.
 *
 * Presets only — the capability flags exist underneath (see ShareCaps) so a finer
 * grant can ship later without a migration, but a checkbox per capability is a
 * security decision surface, and three named levels are ones a person can
 * actually reason about.
 *
 * Everything here is the *owner's* view. A guest never opens this: sharing on
 * somebody else's behalf is not a grant anyone holds.
 */
export function ShareModal({
  opened,
  onClose,
  deviceId,
  machineName,
  session,
}: {
  opened: boolean;
  onClose: () => void;
  deviceId: string;
  machineName: string | null;
  /** Omitted for a machine-wide share. */
  session?: { id: string; name: string };
}) {
  // Scope is a mode of this modal rather than a second component: the presets,
  // the member list and the invite box are identical, and "share the machine
  // instead" is a link inside the same dialog.
  const [scope, setScope] = useState<'session' | 'machine'>(session ? 'session' : 'machine');
  const [preset, setPreset] = useState<SharePreset>('prompt');
  const [email, setEmail] = useState('');
  const [grants, setGrants] = useState<ShareGrant[] | null>(null);
  const [invites, setInvites] = useState<ShareInvite[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clipboard = useClipboard({ timeout: 1500 });

  const sessionId = scope === 'session' ? session?.id : undefined;

  const load = async () => {
    setError(null);
    try {
      const { granted, invites: pending } = await listShares();
      // Only this scope's grants: a machine share and a session share on the same
      // machine are different rows, and mixing them in one list would make
      // "who can see this session" unanswerable.
      setGrants(
        granted.filter((g) =>
          sessionId ? g.sessionId === sessionId : g.kind === 'machine' && g.deviceId === deviceId,
        ),
      );
      setInvites(
        pending.filter((i) =>
          sessionId ? i.sessionId === sessionId : !i.sessionId && i.deviceId === deviceId,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (opened) void load();
    // Re-runs on a scope switch: the two scopes list different grants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, scope, sessionId]);

  // A fresh link belongs to the scope and preset that were set when it was
  // minted, so changing either retires it rather than leaving a stale one on
  // screen under new copy.
  useEffect(() => setLink(null), [scope, preset]);

  const mint = async (withEmail: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const { code } = await createInvite({
        deviceId,
        sessionId: sessionId ?? null,
        inviteeEmail: withEmail ? email.trim() : null,
        preset,
      });
      if (withEmail) setEmail('');
      // The link is shown either way. There is no email provider wired up yet, so
      // for an address-bound invite this is the *only* way to deliver it — saying
      // "sent" would be a lie.
      setLink(joinUrl(code));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const title =
    scope === 'session' && session ? `Share “${session.name}”` : `Share ${machineName ?? 'this machine'}`;

  return (
    <Modal opened={opened} onClose={onClose} title={title} size="lg" centered>
      <Stack gap="md">
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        <Stack gap={6}>
          <Text size="sm" fw={500}>
            Invite by email
          </Text>
          <Group gap="xs" wrap="nowrap">
            <TextInput
              placeholder="colleague@company.com"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && email.trim() && void mint(true)}
              style={{ flex: 1 }}
              type="email"
            />
            <Button onClick={() => void mint(true)} loading={busy} disabled={!email.trim()}>
              Create invite
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            They don’t need a Lines account yet — they’ll be asked to sign up when they open the
            invite. Only the address you enter can accept it.
          </Text>
        </Stack>

        <Stack gap={6}>
          <Text size="sm" fw={500}>
            Access
          </Text>
          <Radio.Group value={preset} onChange={(v) => setPreset(v as SharePreset)}>
            <Stack gap={8}>
              {(['view', 'prompt', 'collaborator'] as SharePreset[]).map((option) => (
                <Radio
                  key={option}
                  value={option}
                  label={
                    <Stack gap={0}>
                      <Text size="sm">{PRESET_COPY[option].label}</Text>
                      <Text size="xs" c="dimmed">
                        {PRESET_COPY[option].detail}
                        {option === 'collaborator' && scope === 'machine'
                          ? ' Can also start new sessions.'
                          : ''}
                      </Text>
                    </Stack>
                  }
                />
              ))}
            </Stack>
          </Radio.Group>
          {/* Conditional, not permanent: a warning that is always on screen is
              ignored noise, and this one has to actually be read. */}
          {preset === 'collaborator' && (
            <Alert
              color="orange"
              variant="light"
              icon={<IconAlertTriangle size={16} />}
              styles={{ message: { fontSize: 'var(--mantine-font-size-xs)' } }}
            >
              Approving a permission runs commands on your machine, as you, on your Anthropic plan.
            </Alert>
          )}
        </Stack>

        <Stack gap={6}>
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm" fw={500}>
              Or share a link
            </Text>
            <Button
              size="xs"
              variant="light"
              onClick={() => void mint(false)}
              loading={busy}
            >
              Create link
            </Button>
          </Group>
          {link && (
            <Group gap="xs" wrap="nowrap">
              <TextInput readOnly value={link} style={{ flex: 1 }} size="xs" />
              <Button size="xs" variant="subtle" onClick={() => clipboard.copy(link)}>
                {clipboard.copied ? 'Copied' : 'Copy'}
              </Button>
            </Group>
          )}
          <Text size="xs" c="dimmed">
            Single use · expires in 7 days
          </Text>
        </Stack>

        <Divider />

        <Stack gap={6}>
          <Text size="sm" fw={500}>
            People with access
          </Text>
          {!grants ? (
            <Group justify="center" p="sm">
              <Loader size="xs" />
            </Group>
          ) : grants.length === 0 && invites.length === 0 ? (
            <Text size="xs" c="dimmed">
              Nobody else yet.
            </Text>
          ) : (
            <Stack gap={6}>
              {grants.map((grant) => (
                <Group key={`${grant.kind}-${grant.userId}-${grant.sessionId ?? ''}`} gap="xs" wrap="nowrap">
                  <Avatar src={grant.profile?.imageUrl ?? undefined} size={24} radius="xl">
                    {(grant.profile?.name ?? grant.profile?.email ?? '?').slice(0, 1).toUpperCase()}
                  </Avatar>
                  <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" truncate>
                      {grant.profile?.name ?? grant.profile?.email ?? grant.userId}
                    </Text>
                    {grant.profile?.email && grant.profile.name && (
                      <Text size="xs" c="dimmed" truncate>
                        {grant.profile.email}
                      </Text>
                    )}
                  </Stack>
                  {/* Narrowing a live grant, rather than revoke-and-re-invite:
                      the relay re-authorizes guest channels within a minute, so
                      this lands on an open tab. */}
                  <Select
                    size="xs"
                    w={140}
                    data={(['view', 'prompt', 'collaborator'] as SharePreset[]).map((p) => ({
                      value: p,
                      label: PRESET_COPY[p].label,
                    }))}
                    value={grant.preset ?? null}
                    placeholder="custom"
                    allowDeselect={false}
                    disabled={busy}
                    onChange={(v) => v && void act(() => setGrantPreset(grant, v as SharePreset))}
                  />
                  <Tooltip label="Revoke access" withArrow>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      disabled={busy}
                      onClick={() => void act(() => revokeGrant(grant))}
                      aria-label="Revoke access"
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              ))}
              {invites.map((invite) => (
                <Group key={invite.code} gap="xs" wrap="nowrap">
                  <Avatar size={24} radius="xl" variant="light" color="gray" />
                  <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" truncate>
                      {invite.inviteeEmail ?? 'Anyone with the link'}
                    </Text>
                    <Text size="xs" c="dimmed">
                      invited {new Date(invite.createdAt).toLocaleDateString()} · not yet accepted
                      {invite.preset ? ` · ${PRESET_COPY[invite.preset].label}` : ''}
                    </Text>
                  </Stack>
                  <Tooltip label="Cancel invite" withArrow>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      disabled={busy}
                      onClick={() => void act(() => revokeInvite(invite.code))}
                      aria-label="Cancel invite"
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              ))}
            </Stack>
          )}
        </Stack>

        {session && (
          <Text size="xs" c="dimmed">
            {scope === 'session' ? (
              <>
                This session runs on your machine.{' '}
                <Anchor size="xs" onClick={() => setScope('machine')}>
                  Share the whole machine…
                </Anchor>
              </>
            ) : (
              <>
                Everyone here can use every session on this machine.{' '}
                <Anchor size="xs" onClick={() => setScope('session')}>
                  Share only “{session.name}”
                </Anchor>
              </>
            )}
          </Text>
        )}
      </Stack>
    </Modal>
  );
}
