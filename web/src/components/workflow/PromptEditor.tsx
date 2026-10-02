import { useRef } from 'react';
import { Button, Menu, Text, Textarea } from '@mantine/core';
import { IconBraces, IconChevronDown } from '@tabler/icons-react';
import styles from './workflow.module.css';

const MONO = { input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } };

/** One token in the Insert menu: the token itself, and a line on what it becomes. */
function TokenItem({
  token,
  hint,
  dim = false,
  onPick,
}: {
  token: string;
  hint: string;
  /** Offered, but not filled in this step as configured (e.g. {previous} without a fresh start). */
  dim?: boolean;
  onPick: () => void;
}) {
  return (
    <Menu.Item onClick={onPick}>
      <Text size="xs" ff="monospace" c={dim ? 'dimmed' : undefined}>
        {token}
      </Text>
      <Text fz={11} c="dimmed" lh={1.35}>
        {hint}
      </Text>
    </Menu.Item>
  );
}

export function PromptEditor({
  value,
  onChange,
  readOnly,
  error,
  inputClassName,
  freshStart,
  availableOutputs = [],
  fill = false,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly: boolean;
  error?: string;
  inputClassName?: string;
  /** When true, the step runs in a fresh session, so the hand-off tokens are filled. */
  freshStart?: boolean;
  /** Named outputs published by earlier steps — offered as {outputs.<name>} tokens. */
  availableOutputs?: string[];
  /** Take the parent's height and scroll inside, instead of growing with the text. */
  fill?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // caretBack: chars from the end of the inserted token to drop the caret, so a
  // template like "{outputs.}" can land the caret between the "." and the "}".
  // The textarea keeps its selection while the menu has focus, so the token
  // lands where the caret was before the menu opened.
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
    <div className={fill ? styles.promptFill : undefined}>
      <div className={styles.promptHeader}>
        <div className={styles.label}>Prompt</div>
        {!readOnly && (
          <Menu position="bottom-end" width={320} shadow="md" withinPortal>
            <Menu.Target>
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<IconBraces size={12} />}
                rightSection={<IconChevronDown size={12} />}
              >
                Insert
              </Button>
            </Menu.Target>
            <Menu.Dropdown mah={440} style={{ overflowY: 'auto' }}>
              <Menu.Label>Task input</Menu.Label>
              <TokenItem
                token="{task}"
                hint="The task the run started with."
                onPick={() => insert('{task}')}
              />
              <TokenItem
                token="{feedback}"
                hint="What a retry asked to change; empty on the first run, appended if left out."
                onPick={() => insert('{feedback}')}
              />
              <Menu.Label>Outputs of earlier steps</Menu.Label>
              {availableOutputs.map((name) => (
                <TokenItem
                  key={name}
                  token={`{outputs.${name}}`}
                  hint={`The output published as “${name}”.`}
                  onPick={() => insert(`{outputs.${name}}`)}
                />
              ))}
              <TokenItem
                token="{outputs.…}"
                hint="Any earlier step's named output."
                onPick={() => insert('{outputs.}', 1)}
              />
              <Menu.Label>Other run variables</Menu.Label>
              <TokenItem
                token="{previous}"
                dim={!freshStart}
                hint={(freshStart ? '' : 'Fresh start only. ') + "The previous step's final message."}
                onPick={() => insert('{previous}')}
              />
              <TokenItem
                token="{diff}"
                hint="The git diff since the run started, cut past a size cap."
                onPick={() => insert('{diff}')}
              />
              <TokenItem
                token="{changed}"
                hint="Every file changed since the run started, never cut."
                onPick={() => insert('{changed}')}
              />
              <TokenItem
                token="{roots}"
                hint="The project's folders, with repo root and branch."
                onPick={() => insert('{roots}')}
              />
              <Menu.Divider />
              <Text fz={11} c="dimmed" px="sm" py={4} lh={1.35}>
                In a fresh start, a prompt using {'{previous}'}, {'{diff}'}, {'{changed}'} or an output gets no
                automatic hand-off.
              </Text>
            </Menu.Dropdown>
          </Menu>
        )}
      </div>
      <Textarea
        ref={ref}
        {...(fill ? { autosize: false } : { autosize: true, minRows: 3, maxRows: 12 })}
        placeholder="Step prompt. {task} = user task, {feedback} = retry feedback."
        value={value}
        readOnly={readOnly}
        error={error}
        styles={inputClassName ? undefined : MONO}
        classNames={{
          ...(fill ? { root: styles.promptFillRoot, wrapper: styles.promptFillWrapper } : {}),
          input: [inputClassName, fill && styles.promptFillInput].filter(Boolean).join(' ') || undefined,
        }}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </div>
  );
}
