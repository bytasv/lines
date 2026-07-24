import { useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  Group,
  Paper,
  Radio,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { IconHelpCircle } from '@tabler/icons-react';
import type { AskUserQuestionInput, PermissionRequestData } from '@lines/shared';
import { send } from '../ws';

const OTHER = '__other__';

interface QuestionState {
  selected: string[]; // option labels, or [OTHER]
  otherText: string;
}

function OptionCard({
  label,
  description,
  checked,
  multi,
  onToggle,
}: {
  label: string;
  description?: string;
  checked: boolean;
  multi: boolean;
  onToggle: () => void;
}) {
  return (
    <UnstyledButton onClick={onToggle} w="100%">
      <Paper
        withBorder
        radius="md"
        px="sm"
        py={8}
        style={{
          borderColor: checked ? 'var(--mantine-primary-color-filled)' : undefined,
          background: checked ? 'var(--mantine-color-default-hover)' : undefined,
        }}
      >
        <Group gap="sm" wrap="nowrap" align="flex-start">
          {multi ? (
            <Checkbox checked={checked} onChange={onToggle} size="xs" mt={2} tabIndex={-1} />
          ) : (
            <Radio checked={checked} onChange={onToggle} size="xs" mt={2} tabIndex={-1} />
          )}
          <div>
            <Text size="sm" fw={checked ? 600 : 500}>
              {label}
            </Text>
            {description && (
              <Text size="xs" c="dimmed">
                {description}
              </Text>
            )}
          </div>
        </Group>
      </Paper>
    </UnstyledButton>
  );
}

export function QuestionPrompt({
  sessionId,
  data,
  resolution,
}: {
  sessionId: string;
  data: PermissionRequestData;
  resolution?: 'allow' | 'deny' | 'expired';
}) {
  const input = data.input as unknown as AskUserQuestionInput;
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const [state, setState] = useState<QuestionState[]>(
    questions.map(() => ({ selected: [], otherText: '' })),
  );

  const toggle = (qi: number, label: string, multi: boolean) => {
    setState((prev) =>
      prev.map((s, i) => {
        if (i !== qi) return s;
        if (multi) {
          const selected = s.selected.includes(label)
            ? s.selected.filter((l) => l !== label)
            : [...s.selected.filter((l) => l !== OTHER), label];
          return { ...s, selected };
        }
        return { ...s, selected: [label] };
      }),
    );
  };

  const answerFor = (qi: number): string => {
    const s = state[qi];
    const labels = s.selected.map((l) => (l === OTHER ? s.otherText.trim() : l)).filter(Boolean);
    return labels.join(', ');
  };

  const allAnswered = questions.every((_, i) => answerFor(i).length > 0);

  const submit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      answers[q.question] = answerFor(i);
    });
    send({
      type: 'permissionResponse',
      sessionId,
      requestId: data.requestId,
      allow: true,
      updatedInput: { questions: input.questions, answers },
      answers,
    });
  };

  // Resolved view: compact summary of what was chosen.
  if (resolution) {
    return (
      <Paper withBorder radius="md" p="sm">
        <Group gap="xs" mb={data.answers ? 6 : 0}>
          <IconHelpCircle size={16} opacity={0.6} />
          <Text size="sm" fw={600}>
            Claude asked
          </Text>
          <Badge
            color={resolution === 'allow' ? 'teal' : resolution === 'expired' ? 'gray' : 'red'}
            variant="light"
          >
            {resolution === 'allow' ? 'answered' : resolution === 'expired' ? 'expired' : 'skipped'}
          </Badge>
        </Group>
        {resolution === 'expired' && (
          <Text size="xs" c="dimmed" mt={4}>
            Question no longer active — re-send your prompt and Claude will ask again.
          </Text>
        )}
        {data.answers &&
          Object.entries(data.answers).map(([q, a]) => (
            <Stack key={q} gap={0} mt={4}>
              <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                {q}
              </Text>
              <Text size="xs" fw={600} style={{ overflowWrap: 'anywhere' }}>
                {a}
              </Text>
            </Stack>
          ))}
      </Paper>
    );
  }

  return (
    <Paper withBorder radius="md" p="sm" style={{ borderColor: 'var(--mantine-primary-color-filled)' }}>
      <Group gap="xs" mb="xs">
        <IconHelpCircle size={16} color="var(--mantine-primary-color-filled)" />
        <Text size="sm" fw={600}>
          Claude has {questions.length === 1 ? 'a question' : `${questions.length} questions`}
        </Text>
      </Group>
      <Stack gap="md">
        {questions.map((q, qi) => (
          <div key={qi}>
            <Group gap={6} mb={6}>
              <Badge variant="light">{q.header}</Badge>
              <Text size="sm" fw={500}>
                {q.question}
              </Text>
            </Group>
            <Stack gap={6}>
              {q.options.map((opt) => (
                <OptionCard
                  key={opt.label}
                  label={opt.label}
                  description={opt.description}
                  checked={state[qi].selected.includes(opt.label)}
                  multi={Boolean(q.multiSelect)}
                  onToggle={() => toggle(qi, opt.label, Boolean(q.multiSelect))}
                />
              ))}
              <OptionCard
                label="Other…"
                description="Type your own answer"
                checked={state[qi].selected.includes(OTHER)}
                multi={Boolean(q.multiSelect)}
                onToggle={() => toggle(qi, OTHER, Boolean(q.multiSelect))}
              />
              {state[qi].selected.includes(OTHER) && (
                <TextInput
                  placeholder="Your answer"
                  value={state[qi].otherText}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setState((prev) =>
                      prev.map((s, i) => (i === qi ? { ...s, otherText: value } : s)),
                    );
                  }}
                  autoFocus
                />
              )}
            </Stack>
          </div>
        ))}
        <Group justify="space-between">
          <Button
            variant="subtle"
            color="gray"
            size="xs"
            onClick={() =>
              send({ type: 'permissionResponse', sessionId, requestId: data.requestId, allow: false })
            }
          >
            Skip questions
          </Button>
          <Button size="xs" disabled={!allAnswered} onClick={submit}>
            Send answers
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
