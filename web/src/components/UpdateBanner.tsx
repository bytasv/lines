import { useState } from 'react';
import { Box, CloseButton, Text } from '@mantine/core';
import { useStore } from '../store';
import { DESKTOP_DOWNLOAD_URL } from '../lib/storage';
import { useIsPhone } from '../lib/layout';

const DISMISSED_KEY = 'lines.updateDismissed';

/**
 * Indigo pill shown when the desktop shell has spotted a newer release.
 *
 * News, not an outage, which is why it is the calmest colour and its dismissal
 * outlives a reload (per version, in localStorage). All the pills render at the same fixed
 * coordinates, so exactly one may show: this ranks *below* every failure banner
 * (bridge-down, then contract skew, then worker-down, then storage-down — see
 * StorageBanner), and hides for a guest, whose machine this isn't.
 *
 * The action is a plain download link rather than the owner-gated `installUpdate`
 * message: with self-install off, a restart request only opens the download page
 * on the *tray* machine, which a remote browser never sees — the click would look
 * like it did nothing. Hidden on a phone, because that link is the desktop download.
 */
export function UpdateBanner({ headerHeight }: { headerHeight: number }) {
  const status = useStore((s) => s.updateStatus);
  const worker = useStore((s) => s.workerStatus);
  const storage = useStore((s) => s.storageStatus);
  const connection = useStore((s) => s.connectionStatus);
  const access = useStore((s) => s.access);
  const skew = useStore((s) => s.protocolSkew);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY));
  const isPhone = useIsPhone();

  if (connection !== 'connected') return null;
  if (skew) return null;
  if (worker?.connected === false || storage?.available === false) return null;
  if (access) return null;
  if (isPhone) return null;
  if (status?.state !== 'available' || !DESKTOP_DOWNLOAD_URL) return null;
  const version = status.version;
  // Per-version, so dismissing 0.1.4 doesn't also silence 0.1.5. `UpdateStatus`
  // allows 'available' with no version, so those share one key rather than
  // becoming undismissable.
  const dismissKey = version ?? 'unknown';
  if (dismissed === dismissKey) return null;

  return (
    <Box
      style={{
        position: 'fixed',
        top: `calc(var(--lines-safe-top) + ${headerHeight / 2}px)`,
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--mantine-color-indigo-filled)',
        color: 'var(--mantine-color-white)',
        borderRadius: 'var(--mantine-radius-xl)',
        padding: '4px 8px 4px 14px',
        boxShadow: 'var(--mantine-shadow-sm)',
        whiteSpace: 'nowrap',
        maxWidth: '80vw',
      }}
    >
      <Text size="sm" fw={500}>
        {version ? `Lines ${version} is available` : 'A new version of Lines is available'}
        <Text
          span
          size="sm"
          component="a"
          href={DESKTOP_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
          style={{ color: 'inherit', textDecoration: 'underline', marginLeft: 6 }}
        >
          Download
        </Text>
      </Text>
      <CloseButton
        size="sm"
        variant="transparent"
        aria-label="Dismiss update notice"
        style={{ color: 'inherit' }}
        onClick={() => {
          // Keyed by version so the next release re-announces itself.
          localStorage.setItem(DISMISSED_KEY, dismissKey);
          setDismissed(dismissKey);
        }}
      />
    </Box>
  );
}
