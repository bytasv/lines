import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  CloseButton,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { IconMessagePlus, IconMessageQuestion, IconPlayerStop, IconSend } from '@tabler/icons-react';
import type { PlanChatEventData } from '@lines/shared';
import { send } from '../ws';
import { readPlanChatDraft, writePlanChatDraft } from '../store';
import { appendTranscript, formatElapsed, useVoiceDictation } from '../lib/useVoiceDictation';
import { useIsPhone } from '../lib/layout';
import { DictateButton, DictationError, VoiceLimitNotice } from './DictateButton';
import { VoiceWaveform } from './VoiceWaveform';
import { Markdown } from './Markdown';
import { ActivityRow } from './ActivityRow';
import { PromptAuthor } from './PromptAuthor';

/** One question with whatever came back for it. */
interface Exchange {
  askId: string;
  question?: PlanChatEventData;
  reply?: PlanChatEventData;
  /** The answer so far while it streams; dropped once `reply` lands. */
  partial?: PlanChatEventData;
}

function exchangesOf(entries: PlanChatEventData[]): Exchange[] {
  const out: Exchange[] = [];
  const byId = new Map<string, Exchange>();
  for (const entry of entries) {
    let ex = byId.get(entry.askId);
    if (!ex) {
      ex = { askId: entry.askId };
      byId.set(entry.askId, ex);
      out.push(ex);
    }
    if (entry.role === 'question') ex.question = entry;
    else if (entry.role === 'partial') ex.partial = entry;
    else ex.reply = entry;
  }
  return out;
}

/**
 * The plan side-chat: questions about a pending plan, answered by a forked,
 * read-only copy of the agent (server/src/planSideChat.ts). Presentational — the
 * history comes off the plan card's transcript item, and the only thing it sends
 * is `planChatAsk` / `planChatCancel`.
 *
 * Nothing said here reaches the live agent. "Add as comment" is the bridge back:
 * it turns an answer into an ordinary plan comment, which then goes through the
 * card's own Approve / Refine buttons.
 */
export function PlanChat({
  sessionId,
  requestId,
  entries,
  canAsk,
  quote,
  onClearQuote,
  onAddComment,
  onClose,
}: {
  sessionId: string;
  requestId: string;
  entries: PlanChatEventData[];
  /** False on a resolved card, or for someone who may not ask: history only. */
  canAsk: boolean;
  /** The highlighted passage the next question is about. */
  quote?: string;
  onClearQuote: () => void;
  /** Absent on a resolved card — there is no review left to comment on. */
  onAddComment?: (quote: string, note: string) => void;
  onClose: () => void;
}) {
  const isPhone = useIsPhone();
  const exchanges = exchangesOf(entries);
  const last = exchanges.at(-1);
  const pending = !!last?.question && !last.reply;
  const streaming = pending ? last?.partial : undefined;

  const [draft, setDraft] = useState(() => (canAsk ? readPlanChatDraft(sessionId, requestId) : ''));
  useEffect(() => {
    writePlanChatDraft(sessionId, requestId, canAsk ? draft : '');
  }, [draft, canAsk, sessionId, requestId]);

  const dictation = useVoiceDictation(sessionId, (text) => setDraft((prev) => appendTranscript(prev, text)));

  // Opening the chat (or asking about a new passage) puts the caret in the box.
  // A frame late: the focus-mode Modal opens in the same commit and moves focus
  // into itself first.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!canAsk) return;
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [canAsk, quote]);

  // The answer being turned into a comment, and the note's text.
  const [commenting, setCommenting] = useState<{ askId: string; quote: string; note: string } | null>(null);

  // Keep the newest exchange in view as the chat grows.
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight });
  }, [entries.length, pending, streaming?.text]);

  const ask = () => {
    const text = draft.trim();
    if (!text || pending || !canAsk) return;
    dictation.cancel();
    send({
      type: 'planChatAsk',
      sessionId,
      requestId,
      askId: crypto.randomUUID(),
      text,
      ...(quote ? { quote } : {}),
    });
    setDraft('');
    onClearQuote();
  };

  const saveComment = () => {
    if (!commenting || !onAddComment) return;
    const note = commenting.note.trim();
    if (!note) return;
    onAddComment(commenting.quote, note);
    setCommenting(null);
  };

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <Group px="md" py="xs" justify="space-between" wrap="nowrap">
        <Group gap={6} wrap="nowrap">
          <IconMessageQuestion size={16} color="var(--mantine-color-violet-5)" />
          <Text size="sm" fw={600}>
            Ask about the plan
          </Text>
        </Group>
        <CloseButton size="sm" aria-label="Close questions" onClick={onClose} />
      </Group>
      <Text size="xs" c="dimmed" px="md" pb="xs">
        Answered by a copy of the agent that can read files, and change the plan when you ask it to.
        Add an answer as a comment to act on it otherwise.
      </Text>
      <ScrollArea viewportRef={viewport} style={{ flex: 1, minHeight: 0 }} px="md">
        <Stack gap="sm" pb="sm">
          {exchanges.length === 0 && (
            <Text size="xs" c="dimmed">
              {canAsk
                ? 'Highlight a passage and click Ask, or type a question or a change to make below.'
                : 'No questions were asked.'}
            </Text>
          )}
          {exchanges.map((ex) => {
            const commentQuote = ex.question?.quote ?? quote ?? '';
            return (
              <Stack key={ex.askId} gap={4}>
                {ex.question && (
                  // The main transcript's user row: a right-aligned bubble with
                  // the author's avatar beside it, so who asked reads the same way
                  // as who prompted.
                  <Box
                    style={{
                      display: 'flex',
                      justifyContent: 'flex-end',
                      gap: 6,
                      alignItems: 'flex-end',
                      width: '100%',
                    }}
                  >
                    <Paper
                      bg="var(--mantine-color-default-hover)"
                      radius="md"
                      px="sm"
                      py={6}
                      style={{ maxWidth: '85%', minWidth: 0, overflowWrap: 'anywhere' }}
                    >
                      {ex.question.quote && (
                        <Text
                          size="10px"
                          c="dimmed"
                          lineClamp={2}
                          pl={6}
                          mb={2}
                          style={{ borderLeft: '2px solid var(--mantine-color-violet-4)' }}
                        >
                          “{ex.question.quote}”
                        </Text>
                      )}
                      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                        {ex.question.text}
                      </Text>
                    </Paper>
                    <PromptAuthor actor={ex.question.actor} ts={ex.question.at} />
                  </Box>
                )}
                {ex.reply?.role === 'answer' && (
                  <Box px={4}>
                    {ex.reply.planEdited && (
                      <Badge size="xs" variant="light" color="violet" mb={4}>
                        Plan updated
                      </Badge>
                    )}
                    <Box fz="sm">
                      <Markdown text={ex.reply.text} />
                    </Box>
                    {onAddComment && commenting?.askId !== ex.askId && (
                      <Group gap="xs" mt={2}>
                        <Tooltip label={commentQuote ? 'Add to the plan comments' : 'Highlight a passage first'}>
                          <Button
                            size="compact-xs"
                            variant="subtle"
                            leftSection={<IconMessagePlus size={12} />}
                            disabled={!commentQuote}
                            onClick={() =>
                              setCommenting({ askId: ex.askId, quote: commentQuote, note: ex.reply!.text })
                            }
                          >
                            Add as comment
                          </Button>
                        </Tooltip>
                        {ex.reply.costUsd !== undefined && (
                          <Text size="10px" c="dimmed">
                            ${ex.reply.costUsd.toFixed(2)}
                          </Text>
                        )}
                      </Group>
                    )}
                    {commenting?.askId === ex.askId && (
                      <Paper withBorder radius="sm" p={8} mt={4}>
                        <Text size="10px" c="dimmed" lineClamp={2}>
                          “{commenting.quote}”
                        </Text>
                        <Textarea
                          autosize
                          minRows={2}
                          maxRows={8}
                          size="xs"
                          mt={4}
                          autoFocus
                          value={commenting.note}
                          onChange={(e) => {
                            const note = e.currentTarget.value;
                            setCommenting((c) => (c ? { ...c, note } : c));
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              setCommenting(null);
                            }
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault();
                              saveComment();
                            }
                          }}
                        />
                        <Group gap="xs" justify="flex-end" mt={6}>
                          <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setCommenting(null)}>
                            Cancel
                          </Button>
                          <Button size="compact-xs" disabled={!commenting.note.trim()} onClick={saveComment}>
                            Add comment
                          </Button>
                        </Group>
                      </Paper>
                    )}
                  </Box>
                )}
                {ex.reply?.role === 'error' && (
                  <Text size="xs" c="red" px={4}>
                    {ex.reply.text}
                  </Text>
                )}
              </Stack>
            );
          })}
          {/* Same liveness cues as the main transcript: the streaming caret on the
              text, and the shimmering phase line with its elapsed timer. */}
          {pending && streaming?.text && (
            <Box px={4} className="tx-streaming" style={{ minWidth: 0 }}>
              <Markdown text={streaming.text} />
            </Box>
          )}
          {pending && !streaming?.text && (
            <Box px={4}>
              <ActivityRow
                startedAt={last?.question?.at}
                live={null}
                lastEventAt={streaming?.at ?? last?.question?.at}
                text={streaming?.activity ? `${streaming.activity}…` : 'Thinking…'}
              />
            </Box>
          )}
        </Stack>
      </ScrollArea>
      {canAsk && (
        // Built like the main Composer — a bordered card with an unstyled input,
        // a footer row with the mic, and Send turning into Stop while an answer
        // is on its way — so asking here feels like messaging the session.
        <Paper withBorder radius="lg" p="xs" m="sm" mt={4}>
          {quote && (
            <Group gap={4} wrap="nowrap" mb={4} px={6}>
              <Text
                size="10px"
                c="dimmed"
                lineClamp={2}
                pl={6}
                style={{ flex: 1, borderLeft: '2px solid var(--mantine-color-violet-4)' }}
              >
                “{quote}”
              </Text>
              <CloseButton size="xs" aria-label="Remove quote" onClick={onClearQuote} />
            </Group>
          )}
          <Box style={{ position: 'relative' }}>
            <Textarea
              autosize
              minRows={isPhone ? 1 : 2}
              maxRows={10}
              ref={inputRef}
              variant="unstyled"
              styles={{ input: { background: 'transparent', paddingInline: 6 } }}
              data-autofocus
              placeholder={`${quote ? 'Ask about this passage' : 'Ask about the plan, or ask for changes'}…${
                isPhone ? '' : ' (↵ to send, ⇧↵ for newline)'
              }`}
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                // Same keys as the main composer: ↵ sends, ⇧↵ is a newline. On a
                // phone the return key writes a newline and the button sends.
                if (e.shiftKey || (isPhone && !e.metaKey && !e.ctrlKey)) return;
                e.preventDefault();
                ask();
              }}
            />
            {dictation.voice === 'recording' && dictation.voiceLevel && (
              <Paper
                style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex', alignItems: 'center' }}
                px={4}
              >
                <Group gap="xs" wrap="nowrap" w="100%">
                  <Box style={{ flex: 1, minWidth: 0 }} c="dimmed">
                    <VoiceWaveform level={dictation.voiceLevel} height={isPhone ? 24 : 32} />
                  </Box>
                  {dictation.remainingMs !== null ? (
                    <VoiceLimitNotice dictation={dictation} keepFocus />
                  ) : (
                    <Text size="xs" c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {formatElapsed(dictation.elapsed)}
                    </Text>
                  )}
                </Group>
              </Paper>
            )}
          </Box>
          <Group justify="flex-end" gap="xs" px={4} pt={4}>
            <DictateButton dictation={dictation} iconSize={16} size="lg" />
            {pending ? (
              <Tooltip label="Stop the answer">
                <ActionIcon
                  color="gray"
                  variant="default"
                  size="lg"
                  aria-label="Stop answer"
                  onClick={() => send({ type: 'planChatCancel', sessionId, requestId })}
                >
                  <IconPlayerStop size={16} />
                </ActionIcon>
              </Tooltip>
            ) : (
              <ActionIcon
                variant="filled"
                size="lg"
                aria-label="Ask"
                disabled={!draft.trim()}
                onClick={ask}
              >
                <IconSend size={16} />
              </ActionIcon>
            )}
          </Group>
          <DictationError dictation={dictation} />
        </Paper>
      )}
    </Box>
  );
}
