import { ColorSwatch, HoverCard, Stack, Text } from '@mantine/core';
import { colorDetails } from '../lib/colorLiterals';

/** Checkerboard so alpha colors read correctly in the big preview. */
const checkerboard =
  'repeating-conic-gradient(var(--mantine-color-default-border) 0% 25%, transparent 0% 50%) 0 0 / 12px 12px';

function PreviewDropdown({ color }: { color: string }) {
  const details = colorDetails(color);
  return (
    <Stack gap={6}>
      <div style={{ borderRadius: 'var(--mantine-radius-sm)', overflow: 'hidden', background: checkerboard }}>
        <div style={{ height: 64, background: color }} />
      </div>
      <Stack gap={2}>
        <Text size="xs" ff="monospace">
          {color}
        </Text>
        {details && details.hex !== color.toLowerCase() && (
          <Text size="xs" ff="monospace" c="dimmed">
            {details.hex}
          </Text>
        )}
        {details && details.rgb !== color && (
          <Text size="xs" ff="monospace" c="dimmed">
            {details.rgb}
          </Text>
        )}
      </Stack>
    </Stack>
  );
}

export function InlineColorSwatch({ color }: { color: string }) {
  return (
    <HoverCard width={240} position="top" withArrow shadow="md" openDelay={100} closeDelay={100}>
      <HoverCard.Target>
        <span className="color-chip">
          <ColorSwatch color={color} size={12} />
        </span>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <PreviewDropdown color={color} />
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
