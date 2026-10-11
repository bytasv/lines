import { Group, Paper, Text } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { useIsPhone } from '../lib/layout';

/**
 * Stands in for the composer on a session a dev bridge only displays: the
 * installed Lines app runs it, so nothing can be sent from here.
 */
export function ReadOnlySessionNotice() {
  const isPhone = useIsPhone();
  return (
    <Paper
      withBorder
      radius={isPhone ? 0 : 'lg'}
      p="sm"
      m={isPhone ? 0 : 'md'}
      mt={isPhone ? 0 : 4}
      maw={920}
      mx={isPhone ? 0 : 'auto'}
      w="100%"
      style={{ borderColor: 'var(--mantine-color-orange-6)' }}
    >
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <IconLock size={16} color="var(--mantine-color-orange-6)" style={{ flexShrink: 0, marginTop: 2 }} />
        <Text size="sm">
          Read-only: this session runs in the installed Lines app, which shows it live. Start a new
          session here to try dev changes.
        </Text>
      </Group>
    </Paper>
  );
}
