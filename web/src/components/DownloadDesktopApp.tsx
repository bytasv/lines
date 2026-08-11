import {
  Alert,
  Anchor,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  List,
  Stack,
  Text,
} from '@mantine/core';
import { IconAlertTriangle, IconDownload } from '@tabler/icons-react';
import {
  DESKTOP_DOWNLOAD_ENABLED,
  DESKTOP_DOWNLOAD_URL,
  DESKTOP_DOWNLOAD_VERSION,
} from '../lib/storage';

/** The Gatekeeper workaround, verbatim — the user has to be able to copy it. */
const QUARANTINE_COMMAND = 'xattr -dr com.apple.quarantine /Applications/Lines.app';

/**
 * Where a signed-in user actually gets the app.
 *
 * Every other pairing surface assumed the desktop app was already installed,
 * which left no path from "signed in" to "has a machine". This is that path.
 *
 * The Gatekeeper block is stated up front rather than buried: the build is
 * ad-hoc signed (no Apple Developer ID yet), so macOS *will* refuse to open it
 * the first time and will usually say the app is damaged. A user who hits that
 * with no warning concludes the download is broken. No wording removes the
 * cliff — only a Developer ID does — so the honest move is to name it and give
 * the two remedies that work.
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
          href={DESKTOP_DOWNLOAD_URL}
          leftSection={<IconDownload size={16} />}
          style={{ alignSelf: 'flex-start' }}
        >
          Download Lines for macOS
        </Button>

        <Alert
          variant="light"
          color="yellow"
          icon={<IconAlertTriangle size={16} />}
          title="macOS will block it the first time"
        >
          <Stack gap="xs">
            <Text size="sm">
              This build is not notarized yet, so macOS says Lines is damaged or from an
              unidentified developer. It is neither — either of these opens it:
            </Text>
            <List size="sm" spacing={4} type="ordered">
              <List.Item>
                Open <b>System Settings → Privacy &amp; Security</b>, scroll to the message about
                Lines, and click <b>Open Anyway</b>.
              </List.Item>
              <List.Item>Or run this in Terminal once, then open Lines normally:</List.Item>
            </List>
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <Code block style={{ flex: 1 }}>
                {QUARANTINE_COMMAND}
              </Code>
              <CopyButton value={QUARANTINE_COMMAND}>
                {({ copied, copy }) => (
                  <Button size="xs" variant="light" color={copied ? 'teal' : 'gray'} onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                )}
              </CopyButton>
            </Group>
          </Stack>
        </Alert>

        <Text size="sm" c="dimmed">
          Lines runs the agent through Claude Code on your machine, so you need it installed —{' '}
          <Anchor href="https://docs.claude.com/en/docs/claude-code/setup" target="_blank" rel="noreferrer">
            install Claude Code
          </Anchor>
          . A paired machine without it cannot run a session.
        </Text>
      </Stack>
    </Card>
  );
}
