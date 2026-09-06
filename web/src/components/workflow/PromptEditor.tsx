import { useRef } from 'react';
import { Button, Group, Stack, Textarea, Tooltip } from '@mantine/core';

const MONO = { input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } };

export function PromptEditor({
  value,
  onChange,
  readOnly,
  error,
  inputClassName,
  freshStart,
  availableOutputs = [],
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly: boolean;
  error?: string;
  inputClassName?: string;
  /** When true, the step runs in a fresh session, so the hand-off tokens are offered. */
  freshStart?: boolean;
  /** Named outputs published by earlier steps — offered as {outputs.<name>} tokens. */
  availableOutputs?: string[];
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // caretBack: chars from the end of the inserted token to drop the caret, so a
  // template like "{outputs.}" can land the caret between the "." and the "}".
  const insert = (token: string, caretBack = 0) => {
    const el = ref.current;
    if (!el) {
      onChange(value + token);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + token.length - caretBack;
      el.setSelectionRange(caret, caret);
    });
  };

  return (
    <Stack gap={6}>
      {!readOnly && (
        <Group gap={4} justify="flex-end">
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
          <Tooltip
            label={
              (freshStart ? '' : 'Turn on “Fresh start” to use this. ') +
              "Replaced with the previous step's final message (e.g. its plan). A fresh-start step whose template uses {previous}, {diff}, {changed} or any {outputs.…} is assumed to carry its own context — the automatic hand-off block is not prepended."
            }
            withArrow
            multiline
            w={260}
          >
            <Button
              size="compact-xs"
              variant="light"
              color={freshStart ? 'grape' : 'gray'}
              onClick={() => insert('{previous}')}
              styles={{ label: { fontFamily: 'var(--mantine-font-family-monospace)', opacity: freshStart ? 1 : 0.55 } }}
            >
              {'{previous}'}
            </Button>
          </Tooltip>
          <Tooltip
            label="Replaced with the working-tree git diff since this workflow run started. Resolves whether or not “Fresh start” is on. Truncated past a size cap — a step that must never miss a changed file should use {changed} instead."
            withArrow
            multiline
            w={260}
          >
            <Button
              size="compact-xs"
              variant="light"
              color="gray"
              onClick={() => insert('{diff}')}
              styles={{ label: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            >
              {'{diff}'}
            </Button>
          </Tooltip>
          <Tooltip
            label="Replaced with every file changed since this workflow run started, one repo-relative path per line with its git status (A/M/D) — never truncated, so a step staging or reviewing files can use it as the authoritative list. Resolves whether or not “Fresh start” is on."
            withArrow
            multiline
            w={260}
          >
            <Button
              size="compact-xs"
              variant="light"
              color="gray"
              onClick={() => insert('{changed}')}
              styles={{ label: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            >
              {'{changed}'}
            </Button>
          </Tooltip>
          {/* Not dimmed with freshStart off, unlike {previous}: the workspace
              shape is just as useful to a step that continues the same session. */}
          <Tooltip
            label="Replaced with the workspace shape: every folder this project spans, each with its repo root and branch (or “not a git repository”). Use it to scope commands per repo, e.g. git -C <repo root>."
            withArrow
            multiline
            w={260}
          >
            <Button
              size="compact-xs"
              variant="light"
              color="gray"
              onClick={() => insert('{roots}')}
              styles={{ label: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            >
              {'{roots}'}
            </Button>
          </Tooltip>
          <Tooltip
            label="Replaced with the named output of an earlier step. Give a step an “Output name”, then reference it here — works across the whole workflow this step runs in, not just the previous step. A fresh-start step whose template uses {previous}, {diff}, {changed} or any {outputs.…} is assumed to carry its own context — the automatic hand-off block is not prepended."
            withArrow
            multiline
            w={260}
          >
            <Button
              size="compact-xs"
              variant="light"
              color="teal"
              onClick={() => insert('{outputs.}', 1)}
              styles={{ label: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            >
              {'{outputs.…}'}
            </Button>
          </Tooltip>
          {availableOutputs.map((name) => (
            <Tooltip key={name} label={`Replaced with the output of the earlier step named “${name}”.`} withArrow multiline w={240}>
              <Button
                size="compact-xs"
                variant="light"
                color="teal"
                onClick={() => insert(`{outputs.${name}}`)}
                styles={{ label: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
              >
                {`{outputs.${name}}`}
              </Button>
            </Tooltip>
          ))}
        </Group>
      )}
      <Textarea
        ref={ref}
        autosize
        minRows={3}
        maxRows={12}
        placeholder="Step prompt. {task} = user task, {feedback} = retry feedback."
        value={value}
        disabled={readOnly}
        error={error}
        styles={inputClassName ? undefined : MONO}
        classNames={inputClassName ? { input: inputClassName } : undefined}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </Stack>
  );
}
