import { Button, Text } from '@mantine/core';
import { useStore } from '../store';
import { send } from '../ws';
import { SettingsGroup, SettingsRow } from './SettingsLayout';

/**
 * Settings -> Account. One group per provider, named in the group title, so two
 * connected accounts never read as two unlabelled emails.
 */
export function AccountSection({ onClose }: { onClose: () => void }) {
  return (
    <>
      <SettingsGroup title="Claude">
        <ClaudeAccountRow onClose={onClose} />
      </SettingsGroup>
      <SettingsGroup title="OpenAI">
        <OpenaiAccountRow onClose={onClose} />
      </SettingsGroup>
    </>
  );
}

/**
 * The OpenAI (ChatGPT) account, for sessions on a Codex model. A second row
 * rather than a mode of the Claude one: the two are independent connections, and
 * either alone is enough to run turns.
 */
function OpenaiAccountRow({ onClose }: { onClose: () => void }) {
  const auth = useStore((s) => s.openaiAuth);
  const openModal = useStore((s) => s.openOpenaiLoginModal);

  return auth?.loggedIn ? (
    <SettingsRow
      label={
        <>
          {auth.account?.email ?? 'Connected to OpenAI'}
          {auth.account?.organization ? ` · ${auth.account.organization}` : ''}
        </>
      }
      control={
        <Button size="xs" variant="default" onClick={() => send({ type: 'openaiLogout' })}>
          Disconnect
        </Button>
      }
    />
  ) : (
    <SettingsRow
      label={
        <Text span inherit c="dimmed">
          No OpenAI account connected
        </Text>
      }
      control={
        <Button
          size="xs"
          variant="default"
          onClick={() => {
            onClose();
            openModal();
          }}
        >
          Connect…
        </Button>
      }
    />
  );
}

function ClaudeAccountRow({ onClose }: { onClose: () => void }) {
  const auth = useStore((s) => s.auth);
  const openLoginModal = useStore((s) => s.openLoginModal);

  return auth?.loggedIn ? (
    <SettingsRow
      label={
        <>
          {auth.account?.email ?? 'Connected to Claude'}
          {auth.account?.organization ? ` · ${auth.account.organization}` : ''}
        </>
      }
      control={
        <Button size="xs" variant="default" onClick={() => send({ type: 'authLogout' })}>
          Disconnect
        </Button>
      }
    />
  ) : (
    <SettingsRow
      label={
        <Text span inherit c="dimmed">
          No Claude account connected
        </Text>
      }
      control={
        <Button
          size="xs"
          variant="default"
          onClick={() => {
            onClose();
            openLoginModal();
          }}
        >
          Connect…
        </Button>
      }
    />
  );
}
