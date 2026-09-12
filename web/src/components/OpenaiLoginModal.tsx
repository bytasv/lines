import {
  Alert,
  Anchor,
  Button,
  CopyButton,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
} from '@mantine/core';
import { IconAlertCircle, IconCheck, IconCopy, IconExternalLink } from '@tabler/icons-react';
import { useStore } from '../store';
import { send } from '../ws';

/**
 * Connect an OpenAI (ChatGPT) account, so sessions can run on a Codex model.
 *
 * A device code rather than the paste-a-code redirect the Claude modal uses: the
 * bridge binds ephemeral ports and the browser finishing this login is often not
 * on the bridge's machine, so there is no callback URL to come back to. The user
 * reads a code here and types it at auth.openai.com; the bridge polls and
 * announces the result, which is why nothing here submits anything.
 *
 * Never opened automatically, unlike LoginModal: a user who has not asked for an
 * OpenAI model is missing nothing.
 */
export function OpenaiLoginModal() {
  const opened = useStore((s) => s.openaiLoginModalOpen);
  const userCode = useStore((s) => s.openaiUserCode);
  const verificationUrl = useStore((s) => s.openaiVerificationUrl);
  const error = useStore((s) => s.openaiAuthError);
  const close = useStore((s) => s.closeOpenaiLoginModal);
  const connected = useStore((s) => s.connectionStatus === 'connected');

  return (
    <Modal opened={opened} onClose={close} title="Connect OpenAI" size="md" centered>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Connect your ChatGPT account to run sessions on a Codex model. Lines hands the
          login straight to the Codex CLI on this machine and keeps no copy of it.
        </Text>

        {!userCode ? (
          <Button onClick={() => send({ type: 'openaiStartLogin' })} disabled={!connected}>
            Connect with ChatGPT
          </Button>
        ) : (
          <>
            <Text size="sm">
              Open the page below and enter this code. This window updates on its own once
              you approve — there is nothing to paste back.
            </Text>
            <Group gap="xs" wrap="nowrap">
              <Text ff="monospace" fz="xl" fw={700} style={{ letterSpacing: '0.15em' }}>
                {userCode}
              </Text>
              <CopyButton value={userCode}>
                {({ copied, copy }) => (
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                    onClick={copy}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                )}
              </CopyButton>
            </Group>
            {verificationUrl && (
              <Anchor href={verificationUrl} target="_blank" rel="noreferrer noopener" size="sm">
                <Group gap={6} wrap="nowrap" component="span">
                  <IconExternalLink size={14} />
                  <span>Approval page didn’t open? Click here.</span>
                </Group>
              </Anchor>
            )}
            {/* Said explicitly, because the only other feedback this flow gives is
                the window closing on its own — so a login that is quietly stuck
                looks exactly like one that is about to succeed. */}
            <Group gap={8} wrap="nowrap">
              <Loader size="xs" />
              <Text size="xs" c="dimmed">
                Waiting for you to approve… this window closes itself when it lands.
              </Text>
            </Group>
            <Group justify="flex-start">
              <Button variant="subtle" onClick={() => send({ type: 'openaiStartLogin' })}>
                Start over
              </Button>
            </Group>
          </>
        )}

        <Text size="xs" c="dimmed">
          Codex sessions run sandboxed and approve their own tool calls, so permission
          cards, plan mode, workflows and your MCP connections do not apply to them yet.
        </Text>

        {error && (
          <Alert color="red" icon={<IconAlertCircle size={16} />} variant="light">
            {error}
          </Alert>
        )}
      </Stack>
    </Modal>
  );
}
