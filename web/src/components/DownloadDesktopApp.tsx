import { Anchor, Button, Card, Stack, Text } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import {
  DESKTOP_DOWNLOAD_ENABLED,
  DESKTOP_DOWNLOAD_HREF,
  DESKTOP_DOWNLOAD_VERSION,
} from '../lib/storage';

const RUN_FROM_SOURCE_URL = 'https://github.com/bytasv/lines#readme';

/**
 * Where a signed-in user actually gets the app.
 *
 * Every other pairing surface assumed the desktop app was already installed,
 * which left no path from "signed in" to "has a machine". This is that path.
 *
 * The build is signed with a Developer ID and notarized, so macOS opens it with
 * no Gatekeeper prompt and there are no workaround steps to show. A build from
 * before signing (0.2.42 and earlier) still needs the old Privacy & Security /
 * `xattr` steps; the download link always serves the newest build.
 *
 * Renders nothing when no build has been published (see DESKTOP_DOWNLOAD_URL).
 */
export function DownloadDesktopApp() {
  if (!DESKTOP_DOWNLOAD_ENABLED) return null;
  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Stack gap={4}>
          <Text fw={600}>Get the Lines desktop app</Text>
          <Text size="sm" c="dimmed">
            macOS, Apple silicon
            {DESKTOP_DOWNLOAD_VERSION ? ` · version ${DESKTOP_DOWNLOAD_VERSION}` : ''}. Download it,
            drag it to Applications, and launch it — it lives in the menu bar and shows a pairing
            code.
          </Text>
        </Stack>

        <Button
          component="a"
          href={DESKTOP_DOWNLOAD_HREF}
          target="_blank"
          rel="noreferrer noopener"
          leftSection={<IconDownload size={16} />}
          style={{ alignSelf: 'flex-start' }}
        >
          Download Lines for macOS
        </Button>

        <Text size="sm" c="dimmed">
          Lines runs the agent through a coding-agent CLI on your machine — install{' '}
          <Anchor href="https://docs.claude.com/en/docs/claude-code/setup" target="_blank" rel="noreferrer">
            Claude Code
          </Anchor>{' '}
          or{' '}
          <Anchor href="https://github.com/openai/codex" target="_blank" rel="noreferrer">
            Codex
          </Anchor>{' '}
          (at least one). A paired machine with neither cannot run a session.
        </Text>

        <Text size="sm" c="dimmed">
          On Windows or Linux? There is no desktop app yet —{' '}
          <Anchor href={RUN_FROM_SOURCE_URL} target="_blank" rel="noreferrer">
            run Lines from source
          </Anchor>{' '}
          and pair that machine instead.
        </Text>
      </Stack>
    </Card>
  );
}
