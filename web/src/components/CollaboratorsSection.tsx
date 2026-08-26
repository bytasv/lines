import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Avatar,
  Button,
  Group,
  Loader,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconAlertCircle, IconTrash } from '@tabler/icons-react';
import { clearContacts, forgetContact, listContacts, type ShareContact } from '../lib/shares';

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
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        People you have shared a session or a machine with. Kept so the share dialog can offer
        them again — it is not a list of who has access, and removing someone here neither
        grants nor revokes anything.
      </Text>

      {error && (
        <Alert color="red" icon={<IconAlertCircle size={16} />} variant="light">
          {error}
        </Alert>
      )}

      {!contacts ? (
        <Group justify="center" p="md">
          <Loader size="sm" />
        </Group>
      ) : contacts.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nobody yet.
        </Text>
      ) : (
        <Stack gap={6}>
          {contacts.map((contact) => (
            <Group key={contact.email} gap="xs" wrap="nowrap">
              <Avatar src={contact.imageUrl ?? undefined} size={24} radius="xl">
                {(contact.name ?? contact.email).slice(0, 1).toUpperCase()}
              </Avatar>
              <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" truncate>
                  {contact.name ?? contact.email}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {/* The name line already shows the address when there is no
                      name, so only the date is left to add in that case. */}
                  {contact.name ? `${contact.email} · ` : ''}
                  shared {new Date(contact.lastUsedAt).toLocaleDateString()}
                </Text>
              </Stack>
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
            </Group>
          ))}
        </Stack>
      )}

      {contacts && contacts.length > 0 && (
        <Button
          variant="light"
          color="red"
          size="xs"
          loading={busy === 'all'}
          disabled={Boolean(busy)}
          onClick={() => void act('all', clearContacts)}
          style={{ alignSelf: 'flex-start' }}
        >
          Clear all
        </Button>
      )}
    </Stack>
  );
}
