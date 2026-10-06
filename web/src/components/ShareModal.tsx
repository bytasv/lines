import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Autocomplete,
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
import type { AutocompleteProps } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconAlertTriangle, IconTrash } from '@tabler/icons-react';
import type { SharePreset } from '@lines/shared';
import {
  PRESET_COPY,
  createInvite,
  joinUrlWithGrant,
  listContacts,
  listShares,
  rememberInviteGrant,
  revokeGrant,
  revokeInvite,
  setGrantPreset,
  takeInviteGrant,
  type ShareContact,
  type ShareGrant,
  type ShareInvite,
} from '../lib/shares';
import { mintGuestGrant, sendToMachine } from '../ws';
import type { DescribedItem } from '../lib/modelSelect';

/** One suggestion in the email field: the address, with a name under it if known. */
type ContactOption = DescribedItem;

/**
 * Local rather than `renderOptionWithDescription`: that one is typed against
 * `SelectProps['renderOption']` (a `ComboboxItem`) and will not assign to
 * Autocomplete's, whose option is only a `ComboboxGenericItem`.
 */
const renderContactOption: AutocompleteProps['renderOption'] = ({ option }) => {
  const contact = option as ContactOption;
  return (
    <div>
      <Text size="sm">{contact.label}</Text>
      {contact.description && (
        <Text size="xs" c="dimmed">
          {contact.description}
        </Text>
      )}
    </div>
  );
};

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
  // The account's address book, so the email field can offer people already
  // shared with instead of asking for an address from memory. Account-wide and
  // independent of grant state — that is the point of it.
  const [contacts, setContacts] = useState<ShareContact[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when a change reached storage but not the machine itself — which is the
  // side that admits guests now — so the owner knows it is not yet in force there.
  const [machineBehind, setMachineBehind] = useState(false);
  /** Tell the machine; note it when its link is down and the message could not go. */
  const tellMachine = (msg: Parameters<typeof sendToMachine>[1]) => {
    if (!sendToMachine(deviceId, msg)) setMachineBehind(true);
  };
  const clipboard = useClipboard({ timeout: 1500 });

  const sessionId = scope === 'session' ? session?.id : undefined;

  const load = async () => {
    setError(null);
    // Two requests, in parallel, and only one of them may fail loudly: the
    // suggestion list is a convenience, and losing it must not blank out the
    // answer to "who can see this".
    const contactsPromise = listContacts().then(
      (r) => r.contacts,
      () => [] as ShareContact[],
    );
    try {
      const [{ granted, invites: pending }, known] = await Promise.all([
        listShares(),
        contactsPromise,
      ]);
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
      setContacts(known);
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
      // The machine first. It is what admits a guest now — on a grant it minted,
      // never on the relay's word — so an invite it has not vouched for would be
      // a link that opens nothing.
      const grant = await mintGuestGrant(deviceId, { scope, ...(sessionId ? { sessionId } : {}), preset });
      let code: string;
      try {
        ({ code } = await createInvite({
          deviceId,
          sessionId: sessionId ?? null,
          inviteeEmail: withEmail ? email.trim() : null,
          preset,
          grantId: grant.grantId,
        }));
      } catch (err) {
        // No invite, so nobody will ever be handed this token: end the grant
        // rather than leave it redeemable until it expires.
        sendToMachine(deviceId, { type: 'revokeGuestGrant', grantId: grant.grantId });
        throw err;
      }
      rememberInviteGrant(code, grant.grantId);
      if (withEmail) setEmail('');
      // The link is shown either way. There is no email provider wired up yet, so
      // for an address-bound invite this is the *only* way to deliver it — saying
      // "sent" would be a lie. And it is the only way the grant travels: it rides
      // in the fragment, which no server ever sees.
      setLink(joinUrlWithGrant(code, deviceId, grant));
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

  // Contacts already on this scope are dropped: re-suggesting somebody who can
  // already see this is a dead click that ends in "already has access". Compared
  // lowercased on both sides — a profile email and a contact row can differ in
  // case, and a case-sensitive miss would suggest a duplicate.
  const contactOptions = useMemo<ContactOption[]>(() => {
    const here = new Set(
      [
        ...(grants ?? []).map((g) => g.profile?.email),
        ...invites.map((i) => i.inviteeEmail),
      ]
        .filter((e): e is string => Boolean(e))
        .map((e) => e.toLowerCase()),
    );
    return contacts
      .filter((c) => !here.has(c.email.toLowerCase()))
      .slice(0, 8)
      // The label is what Mantine inserts into the input on submit, so it has to
      // stay the bare address. The name goes in the description instead.
      .map((c) => ({ value: c.email, label: c.email, description: c.name ?? undefined }));
  }, [contacts, grants, invites]);

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
        {machineBehind && (
          <Alert color="yellow" variant="light">
            {machineName ?? 'This machine'} isn’t connected, so the change has not reached it yet. Storage
            already has it; once the machine is connected, make the change again so it applies there too.
          </Alert>
        )}

        <Stack gap={6}>
          <Text size="sm" fw={500}>
            Invite by email
          </Text>
          <Group gap="xs" wrap="nowrap">
            <Autocomplete
              placeholder="colleague@company.com"
              data={contactOptions}
              renderOption={renderContactOption}
              value={email}
              onChange={setEmail}
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
              {(Object.keys(PRESET_COPY) as SharePreset[]).map((option) => (
                <Radio
                  key={option}
                  value={option}
                  label={
                    <Stack gap={0}>
                      <Text size="sm">{PRESET_COPY[option].label}</Text>
                      <Text size="xs" c="dimmed">
                        {PRESET_COPY[option].detail}
                        {(option === 'collaborator' || option === 'full') && scope === 'machine'
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
          {(preset === 'collaborator' || preset === 'full') && (
            <Alert
              color="orange"
              variant="light"
              icon={<IconAlertTriangle size={16} />}
              styles={{ message: { fontSize: 'var(--mantine-font-size-xs)' } }}
            >
              Approving a permission runs commands on your machine, as you, on your Anthropic plan.
              {preset === 'full' &&
                ' Full access can also switch a session to Full Auto, which runs commands without asking, and delete sessions.'}
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
                    data={(Object.keys(PRESET_COPY) as SharePreset[]).map((p) => ({
                      value: p,
                      label: PRESET_COPY[p].label,
                    }))}
                    value={grant.preset ?? null}
                    placeholder="custom"
                    allowDeselect={false}
                    disabled={busy}
                    onChange={(v) =>
                      v &&
                      void act(async () => {
                        await setGrantPreset(grant, v as SharePreset);
                        // The machine's ceiling too: a narrower preset already applies
                        // through the relay, but a wider one stops at what was minted.
                        tellMachine({
                          type: 'updateGuestGrant',
                          guestUserId: grant.userId,
                          sessionId: grant.sessionId ?? null,
                          preset: v as SharePreset,
                        });
                      })
                    }
                  />
                  <Tooltip label="Revoke access" withArrow>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      disabled={busy}
                      onClick={() =>
                        void act(() => {
                          // The machine first, and whatever storage answers: it is the
                          // side that admits the guest, and it ends the grant at once.
                          tellMachine({
                            type: 'revokeGuestGrant',
                            guestUserId: grant.userId,
                            sessionId: grant.sessionId ?? null,
                          });
                          return revokeGrant(grant);
                        })
                      }
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
                      onClick={() =>
                        void act(() => {
                          const grantId = takeInviteGrant(invite.code);
                          if (grantId) tellMachine({ type: 'revokeGuestGrant', grantId });
                          return revokeInvite(invite.code);
                        })
                      }
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
