import { useEffect, useRef, useState } from 'react';
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
import { matchAnswerToOptions, parseQuestionAnswers } from '../lib/toolFields';
import { send } from '../ws';

const OTHER = '__other__';

interface QuestionState {
  selected: string[]; // option labels, or [OTHER]
  otherText: string;
}

/** The answer one question contributes, `[OTHER]` resolved to its typed text. */
function answerOf(s: QuestionState): string {
  const labels = s.selected.map((l) => (l === OTHER ? s.otherText.trim() : l)).filter(Boolean);
  return labels.join(', ');
}

/** The selection after picking `label`: a toggle for multiSelect, a swap otherwise. */
function nextSelected(s: QuestionState, label: string, multi: boolean): string[] {
  if (!multi) return [label];
  return s.selected.includes(label)
    ? s.selected.filter((l) => l !== label)
    : [...s.selected.filter((l) => l !== OTHER), label];
}

/**
 * Requests whose card has already claimed focus, keyed by `requestId`. Module
 * scope rather than a ref on purpose: `Transcript` windows its item list and
 * backfills it, so this component can genuinely remount — and a ref would let a
 * remount re-steal focus from wherever the user has moved on to.
 */
const autoFocused = new Set<string>();

function OptionCard({
  label,
  description,
  checked,
  multi,
  onToggle,
  readOnly,
  onKeyDown,
  onFocus,
  onBlur,
  focused,
  tabIndex,
  ref,
}: {
  label: string;
  description?: string;
  checked: boolean;
  multi: boolean;
  onToggle?: () => void;
  /** Settled transcript view: the same card, without a click target. */
  readOnly?: boolean;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Drawn from tracked focus, not `:focus-visible` — a click must show it too. */
  focused?: boolean;
  tabIndex?: number;
  ref?: React.Ref<HTMLButtonElement>;
}) {
  const card = (
    <Paper
      withBorder
      radius="md"
      px="sm"
      py={8}
      style={{
        borderColor: checked ? 'var(--mantine-primary-color-filled)' : undefined,
        background: checked ? 'var(--mantine-color-default-hover)' : undefined,
        // Unpicked options are context, not choices, once the question is answered.
        opacity: readOnly && !checked ? 0.55 : undefined,
        outline: focused ? '2px solid var(--mantine-primary-color-filled)' : undefined,
        outlineOffset: 2,
      }}
    >
      <Group gap="sm" wrap="nowrap" align="flex-start">
        {/*
          `.Indicator` is a plain div with no underlying `<input>` — the wrapping
          button is the sole click target. Plain `Checkbox`/`Radio` render a real
          (if visually hidden) input that keeps its own pointer-events via Mantine's
          CSS, so a click landing on it never reached the wrapper button.
        */}
        {multi ? (
          <Checkbox.Indicator checked={checked} size="xs" mt={2} />
        ) : (
          <Radio.Indicator checked={checked} size="xs" mt={2} />
        )}
        {/* Labels and descriptions are tool-supplied free text, and the Group above is
            `nowrap` — without minWidth: 0 an unbroken token sizes this child by its
            min-content width and widens the transcript column. */}
        <div style={{ minWidth: 0 }}>
          <Text size="sm" fw={checked ? 600 : 500} style={{ overflowWrap: 'anywhere' }}>
            {label}
          </Text>
          {description && (
            <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
              {description}
            </Text>
          )}
        </div>
      </Group>
    </Paper>
  );
  if (readOnly) return card;
  return (
    <UnstyledButton
      ref={ref}
      onClick={onToggle}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      tabIndex={tabIndex}
      w="100%"
      role={multi ? 'checkbox' : 'radio'}
      aria-checked={checked}
    >
      {card}
    </UnstyledButton>
  );
}

/**
 * A settled `AskUserQuestion` call in the transcript: the same option cards the
 * prompt offered, with what was picked still selected. Reuses {@link OptionCard} on
 * purpose — reading back an answer should look like the choice that produced it,
 * which a `Q: A` text pair (or a raw JSON dump) does not.
 */
export function QuestionReview({
  input,
  result,
}: {
  input: Record<string, unknown>;
  result?: string;
}) {
  // Tool inputs reach the web verbatim, so nothing here may be assumed well-formed.
  const questions = Array.isArray(input.questions)
    ? (input.questions as AskUserQuestionInput['questions'])
    : [];
  if (questions.length === 0) return null;
  const answers = parseQuestionAnswers(result);

  return (
    <Stack gap="sm">
      {questions.map((q, qi) => {
        const answer = answers[qi] ?? '';
        const options = Array.isArray(q?.options) ? q.options : [];
        const multi = Boolean(q?.multiSelect);
        const { picked, custom } = matchAnswerToOptions(
          answer,
          options.map((opt) => opt.label),
        );
        return (
          <div key={qi}>
            <Group gap={6} mb={6} wrap="nowrap">
              {q?.header && (
                <Badge variant="light" size="sm" style={{ flexShrink: 0 }}>
                  {q.header}
                </Badge>
              )}
              <Text size="xs" fw={500} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                {q?.question}
              </Text>
            </Group>
            <Stack gap={4}>
              {options.map((opt) => (
                <OptionCard
                  key={opt.label}
                  label={opt.label}
                  description={opt.description}
                  checked={picked.includes(opt.label)}
                  multi={multi}
                  readOnly
                />
              ))}
              {custom.map((text) => (
                <OptionCard key={text} label={text} description="Typed answer" checked multi={multi} readOnly />
              ))}
              {!answer && (
                <Text size="xs" c="dimmed" fs="italic">
                  No answer recorded.
                </Text>
              )}
            </Stack>
          </div>
        );
      })}
    </Stack>
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

  // Roving tabindex: one tab stop per question. The cursor *trails* real DOM
  // focus (see `markActive`) instead of driving it.
  const [activeIdx, setActiveIdx] = useState<number[]>(() => questions.map(() => 0));
  // Which card actually holds DOM focus, as `qi:oi`. Mantine's focus ring is
  // `:focus-visible`, so a mouse-driven advance would otherwise move focus with
  // nothing on screen to show it.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  // Index space per question is `options.length + 1`; the trailing slot is "Other…".
  const cardsRef = useRef<(HTMLButtonElement | null)[][]>(questions.map(() => []));
  const questionsRef = useRef<(HTMLDivElement | null)[]>([]);
  const otherRef = useRef<(HTMLInputElement | null)[]>([]);
  // The send is not idempotent and the card stays pending until the echo lands.
  const sentRef = useRef(false);

  // Tab and mouse move DOM focus without passing through the key handler, so the
  // cursor has to follow reality or the next ArrowDown steps from a stale spot.
  const markActive = (qi: number, oi: number) => {
    setActiveIdx((prev) => (prev[qi] === oi ? prev : prev.map((v, i) => (i === qi ? oi : v))));
  };

  // Focus is pushed imperatively; there is deliberately no effect on `activeIdx`
  // that focuses, because it would re-assert focus on every unrelated transcript
  // re-render — the classic focus-stealing bug.
  //
  // `align: 'question'` is for entering a question: scrolling the focused option
  // into view alone leaves the header and the other options off screen, so the
  // question block goes to the top instead. Moving *within* a question keeps
  // `'nearest'` on the option, which is the minimal, non-jerky scroll.
  const focusOption = (qi: number, oi: number, align: 'question' | 'option' = 'option') => {
    const el = cardsRef.current[qi]?.[oi];
    if (!el) return;
    el.focus({ preventScroll: true });
    if (align === 'question' && questionsRef.current[qi]) {
      // Smooth, so the jump to the next question reads as movement rather than a
      // cut — unless the OS asked us not to animate.
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      questionsRef.current[qi]?.scrollIntoView({
        block: 'start',
        behavior: reduced ? 'auto' : 'smooth',
      });
    } else {
      el.scrollIntoView({ block: 'nearest' });
    }
  };

  /** Where focus lands when a question is entered: its pick, else the first option. */
  const entryIndex = (qi: number, snap: QuestionState[]): number => {
    const picked = snap[qi]?.selected[0];
    if (!picked) return 0;
    if (picked === OTHER) return questions[qi].options.length;
    const at = questions[qi].options.findIndex((opt) => opt.label === picked);
    return at >= 0 ? at : 0;
  };

  /**
   * Moves focus on from `fromQi`. Returns whether it did anything, so a caller
   * that has nowhere to send focus can keep it where it is.
   *
   * `canSubmit` is false for the mouse path: only the Send button or Enter may
   * submit, so a click on the last unanswered option must never fire the send.
   */
  const advance = (fromQi: number, snap: QuestionState[], canSubmit = true): boolean => {
    if (fromQi + 1 < questions.length) {
      const qi = fromQi + 1;
      focusOption(qi, entryIndex(qi, snap), 'question');
      return true;
    }
    // Scanning from 0 includes the current question, so a blank "Other…" or a
    // multi toggled back to empty keeps focus instead of submitting nothing.
    const unanswered = questions.findIndex((_, i) => answerOf(snap[i]).length === 0);
    if (unanswered >= 0) {
      focusOption(unanswered, entryIndex(unanswered, snap), 'question');
      return true;
    }
    if (!canSubmit) return false;
    submit(snap);
    return true;
  };

  /**
   * The single write path. `setState` takes a plain value, not an updater, so
   * `advance` can read the identical array this call just committed. Selecting
   * never submits — `advance` is called with `canSubmit: false`.
   */
  const pick = (qi: number, oi: number, label: string, multi: boolean, thenAdvance: boolean) => {
    const wasAnswered = answerOf(state[qi]).length > 0;
    const next = state.map((s, i) =>
      i === qi ? { ...s, selected: nextSelected(s, label, multi) } : s,
    );
    setState(next);
    markActive(qi, oi);
    // Revising an answer is not progress. If the question already had one and the
    // next question is answered too, there is nothing to move on *to* — scrolling
    // away would just take the user off the choice they came back to change.
    const revising = wasAnswered && qi + 1 < questions.length && answerOf(next[qi + 1]).length > 0;
    const moved = thenAdvance && !revising && advance(qi, next, false);
    // Safari and Firefox do not focus a `<button>` on click; "Other…" is exempt
    // because its `TextInput` autofocuses instead.
    if (!moved && label !== OTHER) focusOption(qi, oi);
  };

  const onCardKeyDown = (
    e: React.KeyboardEvent,
    qi: number,
    oi: number,
    label: string,
    multi: boolean,
  ) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return;
    const lastIdx = questions[qi].options.length; // the "Other…" card
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (oi < lastIdx) focusOption(qi, oi + 1);
      // A single-select question clamps; a multiSelect one has no "done" key of
      // its own, so falling off the last option is how you leave it.
      else if (multi) advance(qi, state);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (oi > 0) focusOption(qi, oi - 1);
      return;
    }
    if (e.key !== 'Enter') return;
    // `UnstyledButton` is a real `<button>`, so Enter's keydown default action is
    // firing the click. Cancelling it unconditionally keeps this the only
    // activation path — otherwise select-then-advance fires twice.
    e.preventDefault();
    const s = state[qi];
    const selected = s.selected.includes(label);
    if (multi) {
      pick(qi, oi, label, true, false); // toggling never advances
      return;
    }
    if (label === OTHER) {
      if (!selected) pick(qi, oi, label, false, false);
      else if (s.otherText.trim()) advance(qi, state);
      else otherRef.current[qi]?.focus();
      return;
    }
    if (selected) advance(qi, state);
    else pick(qi, oi, label, false, false);
  };

  const allAnswered = questions.every((_, i) => answerOf(state[i]).length > 0);

  const submit = (snap: QuestionState[] = state) => {
    // Re-guarded here, not only on the button: the keyboard path reaches this
    // directly, and the send cannot be taken back.
    if (sentRef.current) return;
    if (!questions.every((_, i) => answerOf(snap[i]).length > 0)) return;
    sentRef.current = true;
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      answers[q.question] = answerOf(snap[i]);
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

  // Claim focus once per request, so a keyboard answer needs no click to start.
  useEffect(() => {
    if (resolution || questions.length === 0) return;
    if (autoFocused.has(data.requestId)) return;
    const active = document.activeElement as HTMLElement | null;
    // Mid-sentence in the composer outranks a card that just appeared.
    if (
      active &&
      (active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT' ||
        active.isContentEditable)
    ) {
      return;
    }
    autoFocused.add(data.requestId);
    // No `scrollIntoView`: the card mounts at the bottom while the transcript's
    // autoscroll is still running, and a focus-driven scroll can trip its
    // `onScroll` into unpinning follow-the-stream.
    cardsRef.current[0]?.[0]?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        {questions.map((q, qi) => {
          const multi = Boolean(q.multiSelect);
          const otherIdx = q.options.length;
          return (
            <div
              key={qi}
              ref={(el) => {
                questionsRef.current[qi] = el;
              }}
              // Breathing room when `advance` pins this block to the top.
              style={{ scrollMarginTop: 8 }}
            >
              <Group gap={6} mb={6}>
                <Badge variant="light">{q.header}</Badge>
                <Text
                  size="sm"
                  fw={500}
                  id={`${data.requestId}-q${qi}`}
                  style={{ minWidth: 0, overflowWrap: 'anywhere' }}
                >
                  {q.question}
                </Text>
              </Group>
              <Stack
                gap={6}
                // `radiogroup` is the required container for `role="radio"`
                // children; there is no checkbox equivalent, so a multiSelect set
                // is a plain group.
                role={multi ? 'group' : 'radiogroup'}
                aria-labelledby={`${data.requestId}-q${qi}`}
                aria-orientation="vertical"
              >
                {q.options.map((opt, oi) => (
                  <OptionCard
                    key={opt.label}
                    ref={(el) => {
                      cardsRef.current[qi][oi] = el;
                    }}
                    label={opt.label}
                    description={opt.description}
                    checked={state[qi].selected.includes(opt.label)}
                    multi={multi}
                    tabIndex={activeIdx[qi] === oi ? 0 : -1}
                    focused={focusedKey === `${qi}:${oi}`}
                    onFocus={() => {
                      markActive(qi, oi);
                      setFocusedKey(`${qi}:${oi}`);
                    }}
                    onBlur={() => setFocusedKey((k) => (k === `${qi}:${oi}` ? null : k))}
                    onKeyDown={(e) => onCardKeyDown(e, qi, oi, opt.label, multi)}
                    onToggle={() => pick(qi, oi, opt.label, multi, !multi)}
                  />
                ))}
                <OptionCard
                  ref={(el) => {
                    cardsRef.current[qi][otherIdx] = el;
                  }}
                  label="Other…"
                  description="Type your own answer"
                  checked={state[qi].selected.includes(OTHER)}
                  multi={multi}
                  tabIndex={activeIdx[qi] === otherIdx ? 0 : -1}
                  focused={focusedKey === `${qi}:${otherIdx}`}
                  onFocus={() => {
                    markActive(qi, otherIdx);
                    setFocusedKey(`${qi}:${otherIdx}`);
                  }}
                  onBlur={() => setFocusedKey((k) => (k === `${qi}:${otherIdx}` ? null : k))}
                  onKeyDown={(e) => onCardKeyDown(e, qi, otherIdx, OTHER, multi)}
                  onToggle={() => pick(qi, otherIdx, OTHER, multi, false)}
                />
                {/* A `textbox` is not a permitted child of `radiogroup`, so the
                    input sits outside the group. */}
              </Stack>
              {state[qi].selected.includes(OTHER) && (
                <TextInput
                  ref={(el) => {
                    otherRef.current[qi] = el;
                  }}
                  mt={6}
                  placeholder="Your answer"
                  value={state[qi].otherText}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setState((prev) =>
                      prev.map((s, i) => (i === qi ? { ...s, otherText: value } : s)),
                    );
                  }}
                  onKeyDown={(e) => {
                    // Bare Enter finishes the typed answer; arrows keep their
                    // native caret behaviour.
                    if (
                      e.key !== 'Enter' ||
                      e.shiftKey ||
                      e.metaKey ||
                      e.ctrlKey ||
                      e.altKey ||
                      e.nativeEvent.isComposing
                    ) {
                      return;
                    }
                    if (!state[qi].otherText.trim()) return;
                    e.preventDefault();
                    advance(qi, state);
                  }}
                  autoFocus
                />
              )}
            </div>
          );
        })}
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
          <Button size="xs" disabled={!allAnswered} onClick={() => submit()}>
            Send answers
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
