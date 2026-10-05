import { useState } from 'react';
import { ActionIcon, Group, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconMicrophone, IconX } from '@tabler/icons-react';
import { formatElapsed, type VoiceDictation } from '../lib/useVoiceDictation';

/**
 * The mic: dictate, then finish (check) or discard (X). Shared by the composer
 * and every card field that takes free text.
 */
export function DictateButton({
  dictation,
  iconSize,
  size,
  onBlockedClick,
  onPress,
  disabledReason,
  showTimer,
  keepFocus,
}: {
  dictation: VoiceDictation;
  iconSize: number;
  size?: string;
  /** A blocked mic Settings can fix; without it the reason shows as `voiceError`. */
  onBlockedClick?: () => void;
  /** Any live press, before it acts — lets a card note which field the mic serves. */
  onPress?: () => void;
  /** Another field's mic holds the recording. */
  disabledReason?: string;
  /** `m:ss` beside the button while recording — for fields without a waveform. */
  showTimer?: boolean;
  /**
   * Keep focus (and any text selection) where it is on press. The card fields
   * want this; their selection and peek logic must not see the click either,
   * hence `data-plan-chrome`.
   */
  keepFocus?: boolean;
}) {
  const { voice, voiceBlock, voiceBlockActionable } = dictation;
  /** The warning dot only shows on hover: a mic that is never set up would
   *  otherwise wear an orange badge in every composer, forever. */
  const [micHovered, setMicHovered] = useState(false);
  const pressProps = keepFocus
    ? { onMouseDown: (e: React.MouseEvent) => e.preventDefault(), 'data-plan-chrome': true }
    : {};
  return (
    <Group gap={4} wrap="nowrap" data-dictate>
      {showTimer && voice === 'recording' && (
        <Text size="xs" c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatElapsed(dictation.elapsed)}
        </Text>
      )}
      {/* Beside the check, not in the overlay: finish and discard are one
          decision, so they sit together under the same thumb. */}
      {voice === 'recording' && (
        <Tooltip label="Discard recording">
          <ActionIcon
            variant="subtle"
            color="gray"
            size={size}
            aria-label="Discard recording"
            onClick={dictation.cancel}
            {...pressProps}
          >
            <IconX size={iconSize} />
          </ActionIcon>
        </Tooltip>
      )}
      <Tooltip
        label={
          disabledReason
            ? disabledReason
            : voiceBlock
              ? voiceBlockActionable && onBlockedClick
                ? `${voiceBlock} — open Voice input settings`
                : voiceBlock
              : voice === 'recording'
                ? 'Finish and transcribe'
                : voice === 'transcribing'
                  ? 'Transcribing…'
                  : 'Dictate'
        }
        withArrow
        multiline
        maw={260}
      >
        {/* Dimmed, not `disabled`: a disabled ActionIcon swallows the click
            that opens Updates. The warning dot is the model picker's. */}
        <ActionIcon
          // Recording: a filled check, the "done" half of the overlay's X.
          variant={voice === 'recording' ? 'filled' : 'subtle'}
          color={voiceBlock || disabledReason ? 'gray' : undefined}
          size={size}
          loading={voice === 'transcribing'}
          aria-label={
            disabledReason ?? voiceBlock ?? (voice === 'recording' ? 'Finish and transcribe' : 'Dictate')
          }
          aria-disabled={voiceBlock !== null || !!disabledReason}
          style={{ position: 'relative', overflow: 'visible' }}
          onMouseEnter={() => setMicHovered(true)}
          onMouseLeave={() => setMicHovered(false)}
          {...pressProps}
          onClick={() => {
            if (disabledReason) return;
            onPress?.();
            // A tooltip never shows on a phone tap, so the unfixable case
            // says itself beside the field instead.
            if (voiceBlock) {
              if (voiceBlockActionable && onBlockedClick) onBlockedClick();
              else dictation.setVoiceError(voiceBlock);
              return;
            }
            void (voice === 'recording' ? dictation.finish() : dictation.start());
          }}
        >
          {/* Only the glyph fades: opacity on the button would fade the
              warning dot with it, on exactly the state it exists for. */}
          {voice === 'recording' ? (
            <IconCheck size={iconSize} />
          ) : (
            <IconMicrophone size={iconSize} opacity={voiceBlock || disabledReason ? 0.5 : 1} />
          )}
          {voiceBlock && micHovered && (
            <ThemeIcon
              size={12}
              radius="xl"
              color="orange"
              variant="filled"
              style={{ position: 'absolute', top: -2, right: -2, pointerEvents: 'none' }}
            >
              <IconAlertTriangle size={8} />
            </ThemeIcon>
          )}
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

/** Room a field's right section needs for the button (and timer) right now. */
export function dictateSectionWidth(dictation: VoiceDictation, showTimer?: boolean): number {
  if (dictation.voice !== 'recording') return 30;
  return showTimer ? 96 : 60;
}

/** A card field's dictation error, under the field; a click dismisses it. */
export function DictationError({ dictation }: { dictation: VoiceDictation }) {
  if (!dictation.voiceError) return null;
  return (
    <Text
      size="xs"
      c="red"
      mt={4}
      onClick={() => dictation.setVoiceError(null)}
      style={{ cursor: 'pointer' }}
    >
      {dictation.voiceError}
    </Text>
  );
}
