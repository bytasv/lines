import { useState, type ReactNode } from 'react';
import { Badge, Button, CopyButton, Group, Text, Tooltip } from '@mantine/core';
import {
  IconCheck,
  IconCopy,
  IconDownload,
  IconExternalLink,
  IconRefresh,
  IconSparkles,
} from '@tabler/icons-react';
import { CLAUDE_INSTALL_URL, CODEX_INSTALL_COMMAND, type UpdateStatus } from '@lines/shared';
import { useStore } from '../store';
import { send } from '../ws';
import {
  DESKTOP_DOWNLOAD_ENABLED,
  DESKTOP_DOWNLOAD_URL,
  DESKTOP_DOWNLOAD_VERSION,
} from '../lib/storage';
import { SettingsGroup, SettingsRow } from './SettingsLayout';

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
 * whatever that shell last reported. The one action beyond a link is "Restart to
 * update", once the shell has a version downloaded and staged.
 *
 * Host-only by construction: SettingsModal's GUEST_SECTIONS filters to Machines,
 * and these rows describe the host's machine.
 */
export function UpdatesSection({ onOpenWhatsNew }: { onOpenWhatsNew: () => void }) {
  const bridge = useStore((s) => s.bridge);
  const worker = useStore((s) => s.workerStatus);
  const update = useStore((s) => s.updateStatus);
  const claudeCli = useStore((s) => s.claudeCli);
  const codexCli = useStore((s) => s.codexCli);

  const updateAvailable = update?.state === 'available';
  const selfUpdating = update?.state === 'downloading' || update?.state === 'ready';
  // The version on offer, when the shell has one; the published DMG's otherwise.
  const offered = updateAvailable || selfUpdating ? update?.version : undefined;

  return (
    <>
      <SettingsGroup title="Versions">
        {/* The changelog is a sibling pane; only the parent can switch (see SessionsSection). */}
        <VersionRow
          name="Lines (this tab)"
          version={__LINES_VERSION__}
          action={
            <Button size="xs" variant="default" leftSection={<IconSparkles size={14} />} onClick={onOpenWhatsNew}>
              What's new
            </Button>
          }
        />

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

        <VersionRow
          name="Claude Code CLI"
          version={claudeCli?.version}
          detail={claudeCli ? `minimum ${claudeCli.minVersion}` : undefined}
          badge={<CliBadge status={claudeCli} />}
          action={
            claudeCli && claudeCli.state !== 'ok' ? (
              <Button
                size="xs"
                variant="light"
                component="a"
                href={CLAUDE_INSTALL_URL}
                target="_blank"
                rel="noreferrer"
                leftSection={<IconExternalLink size={14} />}
              >
                {claudeCli.state === 'missing' ? 'Install' : 'Update'}
              </Button>
            ) : undefined
          }
        />

        {/* The other engine's CLI, on the same terms. Shown even when it is fine,
            like the Claude row: "installed, and this is the version" is what makes
            the missing case legible when it happens. */}
        <VersionRow
          name="Codex CLI"
          version={codexCli?.version}
          detail={codexCli ? `minimum ${codexCli.minVersion}` : undefined}
          badge={<CliBadge status={codexCli} />}
          action={
            codexCli && codexCli.state !== 'ok' ? (
              <CopyButton value={CODEX_INSTALL_COMMAND}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? 'Copied' : CODEX_INSTALL_COMMAND} withArrow>
                    <Button
                      size="xs"
                      variant="light"
                      onClick={copy}
                      leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                    >
                      {copied ? 'Copied' : 'Copy install command'}
                    </Button>
                  </Tooltip>
                )}
              </CopyButton>
            ) : undefined
          }
        />
      </SettingsGroup>

      {/* Hidden rather than shown empty when no build has been published: a
          download button pointing at nothing is worse than none (see storage.ts).
          The version shown is the one on offer — available, downloading or staged
          — else the published DMG's. The running desktop version is the
          bridge row above, which in a packaged install is stamped from the same
          desktop/package.json. */}
      {(DESKTOP_DOWNLOAD_ENABLED || selfUpdating) && (
        <SettingsGroup>
          <VersionRow
            name="Desktop app"
            version={offered ?? DESKTOP_DOWNLOAD_VERSION ?? undefined}
            detail={
              update?.state === 'ready'
                ? 'downloaded, ready to install'
                : update?.state === 'downloading'
                  ? `downloading · ${update.progress ?? 0}%`
                  : 'latest published'
            }
            badge={
              updateAvailable ? (
                <Badge size="xs" color="indigo" variant="light">
                  update available
                </Badge>
              ) : update?.state === 'ready' ? (
                <Badge size="xs" color="indigo" variant="light">
                  ready to install
                </Badge>
              ) : undefined
            }
            action={
              update?.state === 'ready' ? (
                <RestartButton status={update} />
              ) : update?.state === 'downloading' ? undefined : DESKTOP_DOWNLOAD_ENABLED ? (
                // A plain link while the shell cannot install it itself: a
                // download only that shell's machine could use (see UpdateBanner).
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
              ) : undefined
            }
          />
        </SettingsGroup>
      )}
    </>
  );
}


/**
 * Restart the desktop app on this machine into the staged update. The bridge
 * refuses while a session is running (`restartBlocked`), and re-sends the flag as
 * sessions start and finish, so the button follows it.
 */
function RestartButton({ status }: { status: UpdateStatus }) {
  const [asked, setAsked] = useState(false);
  const blocked = status.restartBlocked === true;
  if (blocked && asked) setAsked(false);
  const button = (
    <Button
      size="xs"
      variant="filled"
      disabled={blocked || asked}
      loading={asked}
      leftSection={<IconRefresh size={14} />}
      onClick={() => {
        if (send({ type: 'installUpdate' })) setAsked(true);
      }}
    >
      Restart to update
    </Button>
  );
  if (!blocked) return button;
  return (
    <Tooltip label="A session is running. Restarting would stop it mid-turn." withArrow>
      {/* A disabled button fires no pointer events, so the tooltip needs a wrapper. */}
      <span>{button}</span>
    </Tooltip>
  );
}

/** "not found" / "older than x.y.z" for either CLI, or nothing when it is fine. */
function CliBadge({ status }: { status: { state: string; minVersion: string } | null }) {
  // Null is not "fine", it is "nobody said" — a bridge older than the field, or
  // one that has not said hello yet. Saying so is what stops a blank row reading
  // as a verdict, which is exactly how a stale bridge hides a missing CLI.
  if (!status) {
    return (
      <Badge size="xs" color="gray" variant="light">
        not reported by this bridge
      </Badge>
    );
  }
  if (status.state === 'ok') return null;
  return (
    <Badge size="xs" color={status.state === 'missing' ? 'red' : 'yellow'} variant="light">
      {status.state === 'missing' ? 'not found on this machine' : `older than ${status.minVersion}`}
    </Badge>
  );
}

/**
 * One `name — version — badge` row of a SettingsGroup.
 *
 * An unknown version renders as a dimmed dash rather than dropping the row: the
 * pane's shape stays the same whether or not a bridge has said hello yet, and
 * "we don't know" is a different (and more useful) answer than silence.
 */
export function VersionRow({
  name,
  version,
  detail,
  badge,
  action,
  children,
}: {
  name: string;
  version?: string;
  detail?: ReactNode;
  badge?: ReactNode;
  action?: ReactNode;
  /** Full-width under the row, e.g. a download's progress. */
  children?: ReactNode;
}) {
  return (
    <SettingsRow
      label={
        <Group gap="xs">
          {name}
          {badge}
        </Group>
      }
      description={detail}
      control={
        <Group gap="xs" wrap="nowrap">
          {/* The dash is the "we don't know" answer, and it only reads as one when
              there is nothing beside it. With an action present the row already
              says what is wrong and what to do, and a dash in front of it is noise. */}
          {(version || !action) && (
            <Text size="sm" c={version ? undefined : 'dimmed'} ff="monospace">
              {version ?? '—'}
            </Text>
          )}
          {action}
        </Group>
      }
    >
      {children}
    </SettingsRow>
  );
}
