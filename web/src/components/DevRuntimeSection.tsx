import { useState } from 'react';
import { Button, Text } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { ConfirmModal } from './ConfirmModal';
import { SettingsGroup, SettingsRow } from './SettingsLayout';

/**
 * Dev only: rebuild and restart the worker and bridge on what is on disk now.
 *
 * The automatic reload waits for every session to go idle, so a machine with a
 * parked session can run old code for days. This is the way through, and it
 * kills in-flight turns — hence the confirmation.
 */
export function DevRuntimeSection() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const restart = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/__dev/restart', { method: 'POST', headers: { 'x-lines-dev': 'restart' } });
      const body = (await res.json().catch(() => ({}))) as { error?: string; restarted?: boolean };
      setResult(
        res.ok && body.restarted
          ? { ok: true, text: 'Restarted on the latest code.' }
          : { ok: false, text: body.error ?? `Restart failed (HTTP ${res.status}).` },
      );
    } catch (error) {
      setResult({ ok: false, text: `Restart request failed: ${(error as Error).message}` });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <SettingsGroup title="Local runtime" footer="Visible only in the dev server. Not in a built app.">
      <SettingsRow
        label="Restart worker and bridge"
        description="Builds the current source and restarts both processes together. Running turns stop."
        control={
          <Button
            variant="light"
            color="red"
            leftSection={<IconRefresh size={14} />}
            loading={busy}
            onClick={() => setConfirming(true)}
          >
            Restart
          </Button>
        }
      >
        {result && (
          <Text size="sm" c={result.ok ? 'dimmed' : 'red'} mt={4}>
            {result.text}
          </Text>
        )}
      </SettingsRow>
      <ConfirmModal
        opened={confirming}
        title="Restart the local runtime?"
        message="Every running turn and background task stops."
        confirmLabel="Restart"
        confirmColor="red"
        confirmLoading={busy}
        onConfirm={restart}
        onCancel={() => setConfirming(false)}
      />
    </SettingsGroup>
  );
}
