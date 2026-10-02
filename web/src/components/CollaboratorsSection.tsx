import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Avatar,
  Button,
  Group,
  Loader,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconAlertCircle, IconTrash } from '@tabler/icons-react';
import { clearContacts, forgetContact, listContacts, type ShareContact } from '../lib/shares';
import { ConfirmModal } from './ConfirmModal';
import { SettingsGroup, SettingsRow } from './SettingsLayout';

/**
 * The address book behind the share overlay's email field.
 *
 * It exists because a share is worth repeating and an address is not worth
 * retyping — but that means addresses outlive the grants they came from, so this
 * pane is the release valve. Removal here is a real delete, not a tombstone.
 */
export function CollaboratorsSection() {
  const [contacts, setContacts] = useState<ShareContact[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const { contacts: rows } = await listContacts();
      setContacts(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setContacts([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {error && (
        <Alert color="red" icon={<IconAlertCircle size={16} />} variant="light">
          {error}
        </Alert>
      )}

      {!contacts ? (
        <Group justify="center" p="md">
          <Loader size="sm" />
        </Group>
      ) : (
        // A footer rather than trimmed away: read as an access list, this pane
        // would suggest that removing someone revokes them.
        <SettingsGroup footer="Not a list of who has access: removing someone here neither grants nor revokes anything.">
          {contacts.length === 0 ? (
            <SettingsRow
              label={
                <Text span inherit c="dimmed">
                  Nobody yet.
                </Text>
              }
            />
          ) : (
            contacts.map((contact) => (
              <SettingsRow
                key={contact.email}
                leftSection={
                  <Avatar src={contact.imageUrl ?? undefined} size={24} radius="xl">
                    {(contact.name ?? contact.email).slice(0, 1).toUpperCase()}
                  </Avatar>
                }
                label={<Text inherit truncate>{contact.name ?? contact.email}</Text>}
                description={
                  <Text inherit truncate>
                    {/* The name line already shows the address when there is no
                        name, so only the date is left to add in that case. */}
                    {contact.name ? `${contact.email} · ` : ''}
                    shared {new Date(contact.lastUsedAt).toLocaleDateString()}
                  </Text>
                }
                control={
                  <Tooltip label="Forget this address" withArrow>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      loading={busy === contact.email}
                      disabled={Boolean(busy)}
                      onClick={() => void act(contact.email, () => forgetContact(contact.email))}
                      aria-label={`Forget ${contact.email}`}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                }
              />
            ))
          )}
        </SettingsGroup>
      )}

      {contacts && contacts.length > 0 && (
        <Button
          variant="light"
          color="red"
          size="xs"
          loading={busy === 'all'}
          disabled={Boolean(busy)}
          onClick={() => setConfirmClear(true)}
          style={{ alignSelf: 'flex-start' }}
        >
          Clear all
        </Button>
      )}

      <ConfirmModal
        opened={confirmClear}
        title="Clear all collaborators?"
        message={`The share dialog stops suggesting ${
          contacts?.length === 1 ? 'this person' : `these ${contacts?.length ?? 0} people`
        }. Nobody gains or loses access.`}
        confirmLabel="Clear all"
        confirmColor="red"
        confirmLoading={busy === 'all'}
        onConfirm={() => void act('all', clearContacts).then(() => setConfirmClear(false))}
        onCancel={() => setConfirmClear(false)}
      />
    </>
  );
}
