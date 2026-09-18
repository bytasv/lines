import { Button, Center, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconDeviceDesktop } from '@tabler/icons-react';

/**
 * Stands in for a surface that is genuinely not usable on a phone.
 *
 * The honest list is short and specific: a code editor, a side-by-side diff, a
 * file tree, a recipe editor. These are not "not yet responsive" — they are
 * built around a pointer, a keyboard and a wide viewport, and a shrunk version
 * would be a worse lie than saying so.
 *
 * Deliberately one shared component rather than a per-surface message: the
 * deferral list is a decision about the product, and it should read the same
 * everywhere it applies.
 */
export function BestOnDesktop({
  what,
  onClose,
}: {
  /** What was being opened, in the user's words: "Editing a workflow". */
  what: string;
  /** Offered when this is standing in for a modal the user opened. */
  onClose?: () => void;
}) {
  return (
    <Center h="100%" p="md">
      <Stack align="center" gap="xs" maw={360}>
        <ThemeIcon variant="light" color="gray" size={44} radius="xl">
          <IconDeviceDesktop size={22} />
        </ThemeIcon>
        <Text fw={600}>{what} needs a bigger screen</Text>
        <Text size="sm" c="dimmed" ta="center">
          This one is built around a keyboard and a wide window. Everything you need to run and
          steer a session works here — open this part on a desktop.
        </Text>
        {onClose && (
          <Button variant="default" size="xs" mt="xs" onClick={onClose}>
            Back
          </Button>
        )}
      </Stack>
    </Center>
  );
}
