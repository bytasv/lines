import { Box, Center, Group, Text } from '@mantine/core';
import { UserMenu } from './UserMenu';
import { BrandMark } from './BrandMark';

/**
 * Chrome for every state that renders instead of the app: pairing, connecting,
 * and the failures of both.
 *
 * Without a header these screens are dead ends — no way to sign out, which
 * strands anyone signed in as the wrong account with only the browser back
 * button. The header is deliberately the same height as the app's so the
 * transition into the app does not jump.
 */
export function GateShell({ children }: { children: React.ReactNode }) {
  return (
    <Box h="var(--lines-viewport)" display="flex" className="lines-safe-top" style={{ flexDirection: 'column' }}>
      <Group
        h={56}
        px="md"
        justify="space-between"
        style={{ flexShrink: 0, borderBottom: '1px solid var(--mantine-color-default-border)' }}
      >
        <BrandMark />
        <UserMenu />
      </Group>
      <Box style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <Center mih="100%" p="md">
          {children}
        </Center>
      </Box>
    </Box>
  );
}

/** Shared caption style for the gate screens, so they read as one family. */
export function GateHint({ children }: { children: React.ReactNode }) {
  return (
    <Text size="sm" c="dimmed" ta="center" maw={420}>
      {children}
    </Text>
  );
}
