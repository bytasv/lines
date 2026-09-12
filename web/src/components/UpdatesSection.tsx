import type { ReactNode } from 'react';
import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import { useStore } from '../store';
import {
  DESKTOP_DOWNLOAD_ENABLED,
  DESKTOP_DOWNLOAD_URL,
  DESKTOP_DOWNLOAD_VERSION,
} from '../lib/storage';

/**
 * What this user is actually running, in one place.
 *
 * Until now the only version anywhere was the desktop tray's, which a browser
 * user never sees, plus the UpdateBanner pill — dismissible per version and then
 * gone forever. This is the permanent surface: every moving part, its version,
 * and a download link that does not disappear.
 *
 * Deliberately reports, never computes. There is no client-side "are you
 * outdated" comparison: `DESKTOP_DOWNLOAD_VERSION` against the bridge's would
 * read as "update available" on every dev checkout (bridge 0.1.0 against a
 * published 0.2.x), so the only "available" verdict shown is the desktop shell's
 * own, from `updateStatus`. Nothing here triggers a check either — it shows
 * whatever that shell last reported.
 *
 * Host-only by construction: SettingsModal's GUEST_SECTIONS filters to Machines,
 * and these rows describe the host's machine.
 */
export function UpdatesSection() {
  const bridge = useStore((s) => s.bridge);
  const worker = useStore((s) => s.workerStatus);
  const update = useStore((s) => s.updateStatus);
  const claudeCli = useStore((s) => s.claudeCli);

  const updateAvailable = update?.state === 'available';

  return (
    <>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase">
        Versions
      </Text>

      <VersionRow name="Lines (this tab)" version={__LINES_VERSION__} />

      <VersionRow
        name="Bridge"
        version={bridge?.version}
        detail={bridge ? `protocol ${bridge.appProtocol}` : undefined}
      />

      {/* The worker outlives bridge restarts, so its version is its own row
          rather than an assumed match — a frozen worker beside a hot bridge is
          exactly what this pane exists to make visible. */}
      <VersionRow
        name="Worker"
        version={worker?.version}
        detail={worker && !worker.connected ? 'not connected' : undefined}
        badge={
          worker?.mismatch ? (
            <Badge size="xs" color="red" variant="light">
              speaks protocol {worker.mismatch.worker}, bridge speaks {worker.mismatch.bridge}
            </Badge>
          ) : undefined
        }
      />

      {/* Hidden rather than shown empty when no build has been published: a
          download button pointing at nothing is worse than none (see storage.ts).
          The version shown is the published DMG's, i.e. what is *available* —
          the running desktop version is the bridge row above, which in a packaged
          install is stamped from the same desktop/package.json. */}
      {DESKTOP_DOWNLOAD_ENABLED && (
        <VersionRow
          name="Desktop app"
          version={DESKTOP_DOWNLOAD_VERSION ?? undefined}
          detail="latest published"
          badge={
            updateAvailable ? (
              <Badge size="xs" color="indigo" variant="light">
                update available
              </Badge>
            ) : undefined
          }
          action={
            // A plain link, not the owner-gated `installUpdate` message: with
            // self-install off that only opens the download page on the tray
            // machine, which a remote browser never sees (see UpdateBanner).
            <Button
              size="xs"
              variant={updateAvailable ? 'filled' : 'light'}
              component="a"
              href={DESKTOP_DOWNLOAD_URL}
              target="_blank"
              rel="noreferrer"
              leftSection={<IconDownload size={14} />}
            >
              Download
            </Button>
          }
        />
      )}

      <VersionRow
        name="Claude Code CLI"
        version={claudeCli?.version}
        detail={claudeCli ? `minimum ${claudeCli.minVersion}` : undefined}
        badge={
          claudeCli && claudeCli.state !== 'ok' ? (
            <Badge size="xs" color={claudeCli.state === 'missing' ? 'red' : 'yellow'} variant="light">
              {claudeCli.state === 'missing'
                ? 'not found on this machine'
                : `older than ${claudeCli.minVersion}`}
            </Badge>
          ) : undefined
        }
      />
    </>
  );
}

/**
 * One `name — version — badge` line.
 *
 * An unknown version renders as a dimmed dash rather than dropping the row: the
 * pane's shape stays the same whether or not a bridge has said hello yet, and
 * "we don't know" is a different (and more useful) answer than silence.
 */
function VersionRow({
  name,
  version,
  detail,
  badge,
  action,
}: {
  name: string;
  version?: string;
  detail?: string;
  badge?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="sm">
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Group gap="xs" wrap="nowrap">
          <Text size="sm">{name}</Text>
          {badge}
        </Group>
        {detail && (
          <Text size="xs" c="dimmed">
            {detail}
          </Text>
        )}
      </Stack>
      <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
        <Text size="sm" c={version ? undefined : 'dimmed'} ff="monospace">
          {version ?? '—'}
        </Text>
        {action}
      </Group>
    </Group>
  );
}
