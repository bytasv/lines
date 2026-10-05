import { useEffect, useRef, useState } from 'react';
import { VOICE_LANGUAGES, voiceModelReady, whisperModelFor } from '@lines/shared';
import { useStore } from '../store';
import { transcribeAudio } from '../ws';
import { useSessionMachine } from './can';
import { startVoiceRecording, voiceInputSupported, type VoiceRecording } from './voiceRecorder';

/** What went wrong asking for the mic, in words — the DOMException names are not. */
function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was refused.';
  if (name === 'NotFoundError') return 'No microphone was found.';
  return err instanceof Error ? err.message : 'Could not start the microphone.';
}

/** `m:ss`, for the recording timer. */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A field's text with a transcript appended, a space between when it has some. */
export function appendTranscript(current: string, text: string): string {
  return current.trim() ? `${current.trimEnd()} ${text}` : text;
}

export type VoiceState = 'idle' | 'recording' | 'transcribing';

export interface VoiceDictation {
  voice: VoiceState;
  voiceError: string | null;
  setVoiceError: (error: string | null) => void;
  /** The live recording's loudness probe, for a waveform; null when not recording. */
  voiceLevel: (() => number) | null;
  /** Milliseconds recorded so far. */
  elapsed: number;
  /** Why the mic cannot record, or null. */
  voiceBlock: string | null;
  /** Settings → Voice input can fix `voiceBlock`. */
  voiceBlockActionable: boolean;
  start: () => Promise<void>;
  finish: () => Promise<void>;
  cancel: () => void;
}

/**
 * Local dictation into whatever field the caller owns: record, transcribe on the
 * session's machine, and hand the text to `onText`. Shared by every mic so the
 * composer and the cards cannot drift on what "blocked" or "failed" means.
 *
 * `onText` is read through a ref, so a transcript that lands after a re-render
 * reaches the latest closure rather than the one that started the recording.
 */
export function useVoiceDictation(sessionId: string, onText: (text: string) => void): VoiceDictation {
  const remote = useSessionMachine(sessionId);
  /**
   * Voice input's transcriber is the *session's* machine's, not the one the UI is
   * pointed at: a shared session's audio goes to its host, so the mic follows the
   * host's install. The global copy only for a session whose machine is unknown.
   */
  const whisper = useStore((s) => {
    const slice = remote.deviceId !== null ? s.machines[remote.deviceId] : undefined;
    return slice ? slice.whisper : s.whisper;
  });
  const [voice, setVoice] = useState<VoiceState>('idle');
  const [voiceStartedAt, setVoiceStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recordingRef = useRef<VoiceRecording | null>(null);
  /** Bumped by `cancel`, so a transcription already in flight is dropped. */
  const generationRef = useRef(0);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const ownMachine = useStore((s) => (s.access?.scope ?? 'owner') === 'owner') && !remote.isRemote;
  const where = ownMachine ? 'this machine' : 'the host’s machine';
  // The user's own choice, even on somebody else's machine: it is their speech.
  const voiceLanguage = useStore((s) => s.voiceLanguage);
  const voiceTranslate = useStore((s) => s.voiceTranslate);
  const voiceLanguageLabel = VOICE_LANGUAGES.find((l) => l.code === voiceLanguage)?.label ?? voiceLanguage;
  const voiceModel = whisperModelFor(voiceLanguage);
  /**
   * Why the mic cannot record, or null. Rendered rather than hidden, like a model
   * whose CLI is missing: an absent button reads as "this app has no voice
   * input", a disabled one with a reason says what to install. Ignored once a
   * recording has started, so a status flip mid-recording cannot strand it.
   */
  const voiceBlock =
    voice !== 'idle'
      ? null
      : !voiceInputSupported()
        ? 'Voice input needs a secure (https) page'
        : !whisper
          ? 'This bridge does not report voice input'
          : whisper.state === 'missing-binary'
            ? `Voice input needs whisper.cpp on ${where}`
            : whisper.state === 'outdated'
              ? `whisper.cpp on ${where} is out of date`
              : !voiceModelReady(whisper.models ?? [], voiceLanguage)
                ? `${voiceLanguage === 'auto' ? 'Voice input' : `Dictating in ${voiceLanguageLabel}`} needs a one-time ` +
                  `model download (${voiceModel.sizeLabel}) on ${where}`
                : null;
  /** Settings → Voice input carries the install command and the model download —
   *  but only for your own machine; a guest's copy of Settings has no such pane,
   *  and it would describe the wrong computer anyway. */
  const voiceBlockActionable = voiceBlock !== null && ownMachine && voiceInputSupported();

  // The recording timer, and letting go of the mic if the owner unmounts
  // mid-recording (switching sessions remounts the composer).
  useEffect(() => {
    if (voice !== 'recording') return;
    const timer = setInterval(() => setElapsed(Date.now() - voiceStartedAt), 250);
    return () => clearInterval(timer);
  }, [voice, voiceStartedAt]);
  useEffect(
    () => () => {
      generationRef.current += 1;
      recordingRef.current?.cancel();
    },
    [],
  );
  /** In state rather than read off the ref so a waveform re-renders when a
   *  recording starts. */
  const [voiceLevel, setVoiceLevel] = useState<(() => number) | null>(null);

  /** Throw the recording away, and any transcript still on its way. */
  const cancel = () => {
    generationRef.current += 1;
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setVoiceLevel(null);
    setVoice('idle');
  };

  /** Stop, transcribe on the session's machine, and hand the text over. A
   *  failure leaves the field exactly as it was. */
  const finish = async () => {
    const recording = recordingRef.current;
    if (!recording) return;
    const generation = generationRef.current;
    recordingRef.current = null;
    setVoiceLevel(null);
    setVoice('transcribing');
    try {
      const audio = await recording.stop();
      const text = await transcribeAudio(
        audio,
        { language: voiceLanguage, translate: voiceTranslate },
        remote.deviceId ?? undefined,
      );
      if (generation !== generationRef.current) return;
      if (!text) setVoiceError('Nothing was heard in that recording.');
      else onTextRef.current(text);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setVoiceError(err instanceof Error ? err.message : 'Transcription failed.');
    } finally {
      if (generation === generationRef.current) setVoice('idle');
    }
  };

  const start = async () => {
    setVoiceError(null);
    try {
      // The limit stops capture on its own; transcribing what was caught is the
      // least surprising thing to do with it.
      const recording = await startVoiceRecording({ onLimit: () => void finishRef.current() });
      recordingRef.current = recording;
      setVoiceLevel(() => recording.level);
      setVoiceStartedAt(Date.now());
      setElapsed(0);
      setVoice('recording');
    } catch (err) {
      setVoiceError(micErrorMessage(err));
    }
  };
  // The limit fires long after `start`'s render; it must reach this render's
  // `finish`, which carries the current language settings.
  const finishRef = useRef(finish);
  finishRef.current = finish;

  return {
    voice,
    voiceError,
    setVoiceError,
    voiceLevel,
    elapsed,
    voiceBlock,
    voiceBlockActionable,
    start,
    finish,
    cancel,
  };
}
