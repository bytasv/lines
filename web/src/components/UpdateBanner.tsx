import { useState } from 'react';
import { Box, CloseButton, Menu, Text, UnstyledButton } from '@mantine/core';
import { useStore } from '../store';
import { send } from '../ws';
import { DESKTOP_DOWNLOAD_URL } from '../lib/storage';
import { useIsPhone } from '../lib/layout';

const DISMISSED_KEY = 'lines.updateDismissed';

/**
 * Indigo pill shown when the desktop shell has a newer release for this machine.
 *
 * News, not an outage, which is why it is the calmest colour and its dismissal
 * outlives a reload (per version, in localStorage). All the pills render at the same fixed
 * coordinates, so exactly one may show: this ranks *below* every failure banner
 * (bridge-down, then contract skew, then worker-down, then storage-down — see
 * StorageBanner), and hides for a guest, whose machine this isn't.
 *
 * Two shapes. A self-installing shell downloads in the background and reports
 * 'ready': the action restarts the app on that machine into the new version,
 * through the owner-gated `installUpdate`, which the bridge refuses while a
 * session has a running turn or background task. Refused, the pill counts those
 * sessions and jumps to one (a menu when there are several). 'available' comes from a shell that cannot install it (one
 * from before self-install, or a download that failed): the action is the
 * download page.
 *
 * On a phone only 'ready' shows, and compact: restarting the machine's app works
 * from anywhere, while the download link is a desktop installer a phone cannot
 * use. Settings → Updates carries both actions too.
 */
export function UpdateBanner({ headerHeight }: { headerHeight: number }) {
  const status = useStore((s) => s.updateStatus);
  const worker = useStore((s) => s.workerStatus);
  const storage = useStore((s) => s.storageStatus);
  const connection = useStore((s) => s.connectionStatus);
  const access = useStore((s) => s.access);
  const skew = useStore((s) => s.protocolSkew);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY));
  // The version this tab asked to restart into, so the pill can say so until the
  // bridge goes away under it.
  const [restarting, setRestarting] = useState<string | null>(null);
  const isPhone = useIsPhone();

  if (connection !== 'connected') return null;
  if (skew) return null;
  if (worker?.connected === false || storage?.available === false) return null;
  if (access) return null;
  const ready = status?.state === 'ready';
  if (isPhone && !ready) return null;
  if (!ready && (status?.state !== 'available' || !DESKTOP_DOWNLOAD_URL)) return null;
  const version = status.version;
  // Per version, so dismissing 0.1.4 doesn't also silence 0.1.5, and per shape:
  // having dismissed "available" does not hide "ready to install". `UpdateStatus`
  // allows no version, so those share one key rather than becoming undismissable.
  const dismissKey = `${ready ? 'ready:' : ''}${version ?? 'unknown'}`;
  if (dismissed === dismissKey) return null;
  const blocked = ready && status.restartBlocked === true;
  // A refusal ends the request: once the session finishes, the pill offers the
  // restart again rather than claiming one is under way.
  if (blocked && restarting !== null) setRestarting(null);
  const asked = ready && restarting === (version ?? 'unknown') && !blocked;

  const restart = () => {
    if (send({ type: 'installUpdate' })) setRestarting(version ?? 'unknown');
  };

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
        {ready
          ? isPhone
            ? 'Update ready'
            : version
              ? `Lines ${version} is ready`
              : 'An update is ready'
          : version
            ? `Lines ${version} is available`
            : 'A new version of Lines is available'}
        {ready ? (
          asked ? (
            <Text span size="sm" style={{ marginLeft: 6, opacity: 0.85 }}>
              Restarting…
            </Text>
          ) : blocked ? (
            // Refused, not queued: the bridge will not restart under a running
            // turn, and nothing restarts it later on its own.
            <Blockers blockers={status.restartBlockers} isPhone={isPhone} />
          ) : (
            <UnstyledButton
              onClick={restart}
              style={{
                color: 'inherit',
                font: 'inherit',
                textDecoration: 'underline',
                marginLeft: 6,
              }}
            >
              {isPhone ? 'Restart' : 'Restart to update'}
            </UnstyledButton>
          )
        ) : (
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
        )}
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

/**
 * The sessions refusing the restart, as a count that takes you there: straight to
 * the one, or a menu when there are several. A bridge older than
 * `restartBlockers` sends none, so this keeps the old static text for it.
 */
function Blockers({
  blockers,
  isPhone,
}: {
  blockers: { id: string; title: string }[] | undefined;
  isPhone: boolean;
}) {
  if (!blockers?.length) {
    return (
      <Text span size="sm" style={{ marginLeft: 6, opacity: 0.85 }}>
        {isPhone ? 'Finish sessions first' : 'Restart once no session is running'}
      </Text>
    );
  }
  const open = (id: string) => useStore.getState().openSessionFromAlert(id);
  const n = blockers.length;
  const label = isPhone ? `${n} running` : `${n} ${n === 1 ? 'session' : 'sessions'} running`;
  const style = { color: 'inherit', font: 'inherit', textDecoration: 'underline', marginLeft: 6 };
  if (n === 1) {
    return (
      <UnstyledButton onClick={() => open(blockers[0].id)} style={style}>
        {label}
      </UnstyledButton>
    );
  }
  return (
    <Menu position="bottom" withinPortal>
      <Menu.Target>
        <UnstyledButton style={style}>{label}</UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        {blockers.map((b) => (
          <Menu.Item key={b.id} onClick={() => open(b.id)}>
            {b.title || 'Untitled session'}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
