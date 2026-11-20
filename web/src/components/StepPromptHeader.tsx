import { useState } from 'react';
import { Badge, Box, Button, Collapse, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconCheck, IconChevronDown, IconCopy } from '@tabler/icons-react';
import type { StepPromptInfo } from '@lines/shared';
import { useStore } from '../store';
import { modelLabel } from './workflow/StepSettings';

/**
 * Header row of a workflow step's opening bubble: which step sent it, plus a
 * collapsed-by-default view of the full prompt the step actually sent. The
 * bubble body itself shows only what the user typed (`step.userText`).
 */
export function StepPromptHeader({ step, text }: { step: StepPromptInfo; text: string }) {
  const [open, setOpen] = useState(false);
  const clipboard = useClipboard({ timeout: 1500 });
  // A primitive, so an unrelated store change does not re-render every bubble.
  const model = useStore((s) => (step.model ? modelLabel(s.models, step.model) : null));
  const lines = text.split('\n').length;

  // A missing offset means that section is absent from the prompt.
  const stepStart = step.contextEnd ?? 0;
  const stepEnd = step.goalStart ?? text.length;
  const sections: {
    key: string;
    label: string;
    color: string;
    body: string;
  }[] = [];
  if (step.contextEnd !== undefined) {
    sections.push({
      key: 'context',
      label: 'Context · previous step',
      color: 'yellow',
      body: text.slice(0, step.contextEnd),
    });
  }
  sections.push({
    key: 'step',
    label: `Step · ${step.name}`,
    color: 'blue',
    body: text.slice(stepStart, stepEnd),
  });
  if (step.goalStart !== undefined) {
    sections.push({
      key: 'goal',
      label: 'Goal',
      color: 'grape',
      body: text.slice(step.goalStart),
    });
  }

  return (
    <Box>
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <Box
            w={7}
            h={7}
            style={{
              borderRadius: '50%',
              background: 'var(--mantine-color-blue-6)',
              flexShrink: 0,
            }}
          />
          <Text size="xs" fw={600} truncate>
            Step {step.index + 1} · {step.name}
            {model && (
              <Text span size="xs" fw={400} c="dimmed">
                {' '}
                · {model}
              </Text>
            )}
          </Text>
        </Group>
        <UnstyledButton
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? 'Hide the prompt this step sent' : 'Show the prompt this step sent'}
          style={{ flexShrink: 0 }}
        >
          <Group gap={2} wrap="nowrap">
            <Text size="xs" c="dimmed">
              Prompt
            </Text>
            <IconChevronDown
              size={12}
              color="var(--mantine-color-dimmed)"
              style={{
                transform: open ? 'rotate(180deg)' : undefined,
                transition: 'transform 120ms',
              }}
            />
          </Group>
        </UnstyledButton>
      </Group>
      <Collapse expanded={open} transitionDuration={150}>
        <Box
          mt={6}
          p={8}
          style={{
            borderRadius: 'var(--mantine-radius-sm)',
            background: 'var(--mantine-color-body)',
            border: '1px solid var(--mantine-color-default-border)',
          }}
        >
          <Group justify="space-between" mb={4} wrap="nowrap">
            <Text size="xs" c="dimmed">
              {lines} {lines === 1 ? 'line' : 'lines'} sent
            </Text>
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              leftSection={clipboard.copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
              onClick={() => clipboard.copy(text)}
            >
              {clipboard.copied ? 'Copied' : 'Copy'}
            </Button>
          </Group>
          <Stack gap={6} style={{ maxHeight: 150, overflowY: 'auto' }}>
            {sections.map((s) => (
              <Box key={s.key}>
                <Badge size="xs" variant="light" color={s.color} style={{ textTransform: 'none' }}>
                  {s.label}
                </Badge>
                <Text
                  component="pre"
                  size="xs"
                  ff="monospace"
                  m={0}
                  mt={2}
                  style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >
                  {s.body.trim()}
                </Text>
              </Box>
            ))}
          </Stack>
        </Box>
      </Collapse>
    </Box>
  );
}
