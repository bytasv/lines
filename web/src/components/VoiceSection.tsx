import { useEffect, useId, useState } from 'react';
import { Badge, Button, CopyButton, Progress, Select, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy, IconDownload } from '@tabler/icons-react';
import {
  VOICE_LANGUAGES,
  voiceModelReady,
  WHISPER_INSTALL_COMMAND,
  WHISPER_MODEL_DIR_HINT,
  whisperModelFor,
} from '@lines/shared';
import type { WhisperStatus } from '@lines/shared';
import { useStore } from '../store';
import { send } from '../ws';
import { VersionRow } from './UpdatesSection';
import { SettingsGroup, SettingsRow, SettingsSwitchRow } from './SettingsLayout';

/**
 * Settings -> Voice input: the dictation language (which decides the model),
 * translation, and everything the machine needs for it — the whisper.cpp
 * binary and the one model that language uses, downloaded by the bridge.
 *
 * Host-only like Updates: it reads this machine's install and writes the
 * owner's settings, both of which the bridge refuses to a guest.
 */
export function VoiceSection() {
  const languageId = useId();
  const whisper = useStore((s) => s.whisper);
  const modelDownload = useStore((s) => s.whisperModelDownload);
  const downloading = modelDownload?.state === 'downloading' ? modelDownload : null;
  const voiceLanguage = useStore((s) => s.voiceLanguage);
  const setVoiceLanguage = useStore((s) => s.setVoiceLanguage);
  const voiceTranslate = useStore((s) => s.voiceTranslate);
  const setVoiceTranslate = useStore((s) => s.setVoiceTranslate);
  const model = whisperModelFor(voiceLanguage);
  // Installed, or covered anyway: the multilingual model handles English too.
  const modelReady = voiceModelReady(whisper?.models ?? [], voiceLanguage);
  /**
   * Clicked, and the bridge has not answered yet. A bridge that refuses the
   * message (one running older code does) answers with a generic `error` that
   * lands in the sidebar, not here — so without this the button just does
   * nothing. Cleared by the first `whisperModelDownload` push.
   */
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const [unanswered, setUnanswered] = useState(false);
  useEffect(() => {
    setRequestedAt(null);
    setUnanswered(false);
  }, [modelDownload]);
  useEffect(() => {
    if (requestedAt === null) return;
    const timer = setTimeout(() => setUnanswered(true), 5_000);
    return () => clearTimeout(timer);
  }, [requestedAt]);
  const downloadError = unanswered
    ? 'The bridge did not start the download — it may be running older code. Restart it and try again.'
    : modelDownload?.state === 'error' && modelDownload.file === model.file
      ? modelDownload.message
      : null;
  const whisperCommand = whisper?.state === 'outdated' ? 'brew upgrade whisper-cpp' : WHISPER_INSTALL_COMMAND;

  return (
    <>
      <SettingsGroup title="Dictation">
        <SettingsRow
          label="Dictation language"
          description="Decides the model: English uses a small English-only one, anything else the full multilingual one."
          htmlFor={languageId}
          controlWidth={220}
          control={
            <Select
              id={languageId}
              size="xs"
              data={VOICE_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
              value={voiceLanguage}
              onChange={(v) => v && setVoiceLanguage(v)}
              allowDeselect={false}
              searchable
            />
          }
        />
        {voiceLanguage !== 'en' && (
          <SettingsSwitchRow
            label="Translate to English"
            description="Get the prompt in English whatever language you speak."
            checked={voiceTranslate}
            onChange={setVoiceTranslate}
          />
        )}
      </SettingsGroup>
      <SettingsGroup title="On this machine">
        {/* The desktop app ships the binary, so the usual fix is the model —
            which the bridge downloads itself, from the row below. */}
        <VersionRow
          name="whisper.cpp"
          version={whisper?.version}
          detail={whisper ? `minimum ${whisper.minVersion}` : undefined}
          badge={<WhisperBadge status={whisper} />}
          action={
            whisper && (whisper.state === 'missing-binary' || whisper.state === 'outdated') ? (
              <CopyButton value={whisperCommand}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? 'Copied' : whisperCommand} withArrow>
                    <Button
                      size="xs"
                      variant="light"
                      onClick={copy}
                      leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                    >
                      {copied ? 'Copied' : whisper.state === 'outdated' ? 'Copy update command' : 'Copy install command'}
                    </Button>
                  </Tooltip>
                )}
              </CopyButton>
            ) : undefined
          }
        />
        {/* The one model this language needs, and nothing to choose. Hidden on a
            bridge too old to report whisper: nothing there would answer. */}
        {whisper && (
          <VersionRow
            name={`Model: ${model.label}`}
            detail={
              downloadError ?? `${model.sizeLabel}, stored in ${WHISPER_MODEL_DIR_HINT}/`
            }
            // As the action, not the badge: a row with no action shows the
            // "we don't know" dash, which an installed model is not.
            action={
              modelReady ? (
                <Badge size="xs" color="teal" variant="light">
                  installed
                </Badge>
              ) : (
                <Button
                  size="xs"
                  variant="light"
                  loading={downloading !== null || (requestedAt !== null && !unanswered)}
                  onClick={() => {
                    setUnanswered(false);
                    setRequestedAt(Date.now());
                    send({ type: 'installWhisperModel', file: model.file });
                  }}
                  leftSection={<IconDownload size={14} />}
                >
                  {downloadError ? 'Retry' : 'Download'}
                </Button>
              )
            }
          >
            {downloading && (
              <Progress
                size="sm"
                animated
                // Indeterminate-looking until the server says how big it is.
                value={downloading.total ? (downloading.received / downloading.total) * 100 : 100}
                aria-label="Model download progress"
              />
            )}
          </VersionRow>
        )}
      </SettingsGroup>
    </>
  );
}

/** CliBadge's counterpart for whisper, whose states are its own. */
function WhisperBadge({ status }: { status: WhisperStatus | null }) {
  if (!status) {
    return (
      <Badge size="xs" color="gray" variant="light">
        not reported by this bridge
      </Badge>
    );
  }
  if (status.state === 'ready') return null;
  return (
    <Badge size="xs" color={status.state === 'outdated' ? 'yellow' : 'gray'} variant="light">
      {status.state === 'missing-binary'
        ? 'not installed'
        : status.state === 'missing-model'
          ? 'no model'
          : `older than ${status.minVersion}`}
    </Badge>
  );
}
