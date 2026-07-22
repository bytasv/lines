import { useState } from 'react';
import {
  Alert,
  Anchor,
  Button,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconAlertCircle, IconExternalLink } from '@tabler/icons-react';
import { useStore } from '../store';
import { send } from '../ws';

/**
 * App-managed Claude login. Opens automatically when the bridge reports
 * logged-out; the flow is: start login -> approve in the browser tab the
 * server's authorize URL opens -> paste the `code#state` shown there back
 * here. Dismissible — sessions then fall back to ambient CLI credentials.
 */
export function LoginModal() {
  const opened = useStore((s) => s.loginModalOpen);
  const authorizeUrl = useStore((s) => s.authorizeUrl);
  const authError = useStore((s) => s.authError);
  const close = useStore((s) => s.closeLoginModal);
  const connected = useStore((s) => s.connectionStatus === 'connected');
  const [code, setCode] = useState('');

  const complete = () => {
    if (code.trim()) send({ type: 'authCompleteLogin', code: code.trim() });
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      title="Sign in to Claude"
      size="md"
      centered
      onExitTransitionEnd={() => setCode('')}
    >
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Connect your Claude account so sessions and plan usage run under this app’s own
          login. Approving opens claude.ai in a new tab; it shows a code to paste back here.
        </Text>

        {!authorizeUrl ? (
          <Button onClick={() => send({ type: 'authStartLogin' })} disabled={!connected}>
            Sign in with Claude
          </Button>
        ) : (
          <>
            <Anchor href={authorizeUrl} target="_blank" rel="noopener" size="sm">
              <Group gap={6} wrap="nowrap" component="span">
                <IconExternalLink size={14} />
                <span>Approval page didn’t open? Click here.</span>
              </Group>
            </Anchor>
            <TextInput
              label="Authorization code"
              placeholder="Paste the code shown after approving"
              value={code}
              onChange={(e) => setCode(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && complete()}
              autoFocus
              data-autofocus
            />
            <Group justify="space-between">
              <Button variant="subtle" onClick={() => send({ type: 'authStartLogin' })}>
                Start over
              </Button>
              <Button onClick={complete} disabled={!code.trim()}>
                Complete sign-in
              </Button>
            </Group>
          </>
        )}

        {authError && (
          <Alert color="red" icon={<IconAlertCircle size={16} />} variant="light">
            {authError}
          </Alert>
        )}
      </Stack>
    </Modal>
  );
}
