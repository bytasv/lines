import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertCircle, IconLock, IconLockOpen } from '@tabler/icons-react';
import { ENROLL_CODE_LENGTH, normalizeEnrollCode } from '@lines/shared';
import { useStore } from '../store';
import { cryptoUnavailable, pinnedKey, takeEnrollCodeFromUrl } from '../lib/e2ee';
import { rememberedDeviceId } from '../lib/storage';
import { enrollWithCode } from '../ws';

/**
 * Bind this browser to a machine with a key, so the relay in the middle stops
 * being something either end has to trust.
 *
 * A machine never takes the relay's word for who is connected: every browser
 * enrols once, with a code the user carries from the machine's own screen —
 * which is the one exchange a compromised server cannot sit in the middle of —
 * and from then on the two ends check a key they agreed on directly. The badge
 * below only reads "not end-to-end encrypted" for a guest or a direct link.
 *
 * Says plainly what it does *not* cover: this page is served by the same
 * deployment it distrusts, so a modified bundle defeats everything here. That
 * limit belongs in front of the user, not only in the docs.
 */
export function EncryptionSection() {
  const deviceId = rememberedDeviceId() ?? '';
  const encrypted = useStore((s) => s.machines[s.primaryDeviceId ?? '']?.encrypted ?? false);
  // Prefilled from the code the machine handed this page (QR, or the desktop
  // app's own window), consumed and stripped on read.
  const [code, setCode] = useState(() => takeEnrollCodeFromUrl()?.code ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const pinned = pinnedKey(deviceId);

  // Same reasoning as the connect-time gate: an insecure origin has no
  // WebCrypto, so this whole pane is inert and should say so rather than fail
  // on submit.
  const blocked = cryptoUnavailable();

  const enroll = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await enrollWithCode(deviceId, code);
      if (result.error) {
        setError(result.error);
        return;
      }
      setCode('');
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const ready = !blocked && normalizeEnrollCode(code).length === ENROLL_CODE_LENGTH;

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Every browser enrols once with a code from your machine. From then on, this browser and
        your machine encrypt everything between them and each checks the other’s key directly.
        The relay that connects you carries the traffic — it cannot read it, and it cannot
        pretend to be either of you.
      </Text>

      <Card withBorder padding="sm" radius="sm">
        <Group gap="sm">
          {encrypted ? <IconLock size={18} /> : <IconLockOpen size={18} opacity={0.6} />}
          <Stack gap={2}>
            <Group gap={6}>
              <Text size="sm" fw={500}>
                This connection
              </Text>
              <Badge size="xs" color={encrypted ? 'green' : 'gray'} variant="light">
                {encrypted ? 'end-to-end encrypted' : 'relayed, not end-to-end encrypted'}
              </Badge>
            </Group>
            <Text size="xs" c="dimmed">
              {pinned
                ? 'This browser has a key for this machine.'
                : 'This browser has no key for this machine yet.'}
            </Text>
          </Stack>
        </Group>
      </Card>

      <Card withBorder padding="sm" radius="sm">
        <Stack gap="xs">
          <Text size="sm" fw={500}>
            Enrol this browser
          </Text>
          <Text size="xs" c="dimmed">
            On the machine, open the Lines menu-bar icon and choose “Show encryption code”. Type
            what it shows here. The code is never sent — only a proof computed from it — and it
            works once.
          </Text>
          {blocked && (
            <Alert color="orange" variant="light">
              {blocked}
            </Alert>
          )}
          <TextInput
            placeholder="XXXXX XXXXX XXXXX XXXXX"
            value={code}
            onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && ready && void enroll()}
            disabled={busy || !!blocked}
          />
          {error && (
            <Alert color="red" icon={<IconAlertCircle size={16} />} variant="light">
              {error}
            </Alert>
          )}
          {done && !error && (
            <Alert color="green" variant="light">
              Enrolled. Reconnecting so the link comes up encrypted.
            </Alert>
          )}
          <Group justify="flex-end">
            <Button size="xs" onClick={() => void enroll()} disabled={!ready || busy} loading={busy}>
              Enrol
            </Button>
          </Group>
        </Stack>
      </Card>

      <Text size="xs" c="dimmed">
        What this does not cover: this page itself is served by the same deployment. Somebody who
        can change the code served to your browser can defeat all of the above, because they are
        the code holding the keys. The desktop app closes that gap on a laptop; on a phone, a
        browser cannot.
      </Text>
    </Stack>
  );
}
