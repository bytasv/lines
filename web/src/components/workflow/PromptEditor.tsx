import { useRef, useState } from 'react';
import { Button, Group, Paper, SegmentedControl, Stack, Text, Textarea, Tooltip } from '@mantine/core';
import { renderPromptPreview } from '../../lib/promptPreview';

const MONO = { input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } };

export function PromptEditor({
  value,
  onChange,
  readOnly,
  error,
  sampleTask,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly: boolean;
  error?: string;
  sampleTask: string;
}) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const ref = useRef<HTMLTextAreaElement>(null);

  const insert = (token: string) => {
    const el = ref.current;
    if (!el) {
      onChange(value + token);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + token.length;
      el.setSelectionRange(caret, caret);
    });
  };

  return (
    <Stack gap={6}>
      <Group justify="space-between" gap="xs">
        <SegmentedControl
          size="xs"
          value={mode}
          onChange={(v) => setMode(v as 'edit' | 'preview')}
          data={[
            { value: 'edit', label: 'Edit' },
            { value: 'preview', label: 'Preview' },
          ]}
        />
        {mode === 'edit' && !readOnly && (
          <Group gap={4}>
            <Tooltip label="Replaced with the user's task — the first message they send to kick off the workflow." withArrow multiline w={240}>
              <Button
                size="compact-xs"
                variant="light"
                color="gray"
                onClick={() => insert('{task}')}
                styles={{ label: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
              >
                {'{task}'}
              </Button>
            </Tooltip>
            <Tooltip label="Replaced with the changes the user requested when retrying this step. Empty on the first run; if omitted, feedback is appended to the end." withArrow multiline w={240}>
              <Button
                size="compact-xs"
                variant="light"
                color="gray"
                onClick={() => insert('{feedback}')}
                styles={{ label: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
              >
                {'{feedback}'}
              </Button>
            </Tooltip>
          </Group>
        )}
      </Group>
      {mode === 'edit' ? (
        <Textarea
          ref={ref}
          autosize
          minRows={3}
          maxRows={12}
          placeholder="Step prompt. {task} = user task, {feedback} = retry feedback."
          value={value}
          disabled={readOnly}
          error={error}
          styles={MONO}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      ) : (
        <Paper withBorder radius="md" p="sm" bg="var(--mantine-color-default)">
          <Text ff="monospace" size="xs" style={{ whiteSpace: 'pre-wrap' }}>
            {renderPromptPreview(value, sampleTask) || '(empty)'}
          </Text>
          {!value.includes('{feedback}') && (
            <Text size="xs" c="dimmed" mt="xs">
              Retry feedback will be appended to the end.
            </Text>
          )}
        </Paper>
      )}
    </Stack>
  );
}
