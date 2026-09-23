# Voice input

Covers: `voice-input`, `whisper-transcription`, `whisper-model-download`.

## Purpose

Dictate into the composer instead of typing, transcribed locally on the machine hosting the
session — never sent to Anthropic or OpenAI as audio, and never sent to any third-party
speech-to-text API. Neither Claude Code nor Codex expose their own CLI speech-to-text over the
headless interfaces Lines drives (`@anthropic-ai/claude-agent-sdk`, `codex app-server`), so the
app transcribes itself with a local `whisper-cli` and inserts the result as ordinary text at the
caret — the provider only ever sees a normal prompt.

Two things must be true on the machine for the mic to appear: a `whisper-cli` binary (the desktop
app ships its own; anyone else installs `whisper-cpp` via Homebrew) and a downloaded model. Both
are auto-discovered and self-healing, on the same pattern as the Claude/Codex CLI probes in
[settings-updates-pane](settings-updates-pane.md).

## Entry points

- Composer mic button (`web/src/components/Composer.tsx`) — idle / recording (live waveform) /
  transcribing; disabled-with-a-warning-icon, never hidden, when voice input cannot run
- Settings → **Voice input** (`web/src/components/VoiceSection.tsx`) — dictation language,
  translate-to-English, the whisper.cpp binary status, and the one model that language needs
- `server/src/index.ts` — `transcribe` and `installWhisperModel` message handlers

## Files

- `web/src/lib/voiceRecorder.ts` — `getUserMedia` → 16 kHz mono WAV, base64; a loudness probe for
  the waveform; the 90s auto-stop
- `web/src/components/VoiceWaveform.tsx` — canvas bar waveform drawn from that loudness probe
- `web/src/components/Composer.tsx` — mic/discard/finish controls, the recording overlay, the
  disabled-with-reason state and its link into Settings → Voice input
- `web/src/components/MentionInput.tsx` — `insertAtCaret`, `MentionInputHandle.insertText`: splices
  dictated text at the caret (or over a selection) through the same range-remap mention insertion
  uses, so an @mention pill before the caret shifts correctly
- `web/src/components/VoiceSection.tsx` — the settings pane described above
- `web/src/ws.ts` — `transcribeAudio()`; per-link `transcriptions` map, point-to-point like
  `fileRequest`
- `web/src/store.ts` / `web/src/lib/machines.ts` — `whisper` / `whisperModelDownload` per-machine
  slices; `voiceLanguage` / `voiceTranslate` synced settings
- `server/src/whisperCli.ts` — binary discovery (`LINES_WHISPER_BUNDLED_BIN` →
  `LINES_WHISPER_BIN` → Homebrew → PATH), installed-model discovery, `pickWhisperModel`
- `server/src/whisperModel.ts` — streams a model from Hugging Face into `<app root>/models/`,
  behind one bridge-wide download slot
- `server/src/transcribe.ts` — validates and runs one `whisper-cli` invocation; the one-at-a-time
  queue
- `desktop/scripts/build-whisper.mjs` — compiles a static, Metal-enabled `whisper-cli` into the
  desktop bundle
- `desktop/src/main.ts` — `installMediaPermissions()` (mic only, app origin only, then
  `systemPreferences.askForMediaAccess`); `NSMicrophoneUsageDescription` in `desktop/package.json`
- `shared/types.ts` — `WhisperStatus`, `WHISPER_MODELS`, `whisperModelFor`, `VOICE_LANGUAGES`,
  the `transcribe`/`installWhisperModel`/`transcription`/`whisperModelDownload` messages,
  `MESSAGE_AUTHZ.transcribe`/`installWhisperModel`

## Symbols

- `resolveWhisperStatus` / `whisperStatus()` / `refreshWhisperStatus()` / `publicWhisperStatus()` —
  the same self-healing-cache shape as `codexCliStatus`; a working answer stays cached, a failed
  one for 10s
- `installedWhisperModels()` / `pickWhisperModel(installed, language)` — which of the two known
  model files is present, and which one a given dictation language needs
- `whisperModelFor(language)` (shared) — the client-side mirror of that choice, so the mic warning
  and the Settings pane agree with the bridge without asking it
- `createTranscriber()` / `transcribe` — the bridge's one shared queue; `languageArgs` builds the
  `-l`/`-tr` flags, forcing `en` on the English-only model regardless of what was asked
- `startWhisperModelDownload(file)` / `downloadWhisperModel()` — the `.part`-then-rename-after-
  magic-check download; one at a time, refused while `LINES_WHISPER_MODEL` pins a single file
- `insertAtCaret(value, at, removed, inserted, added?)` — shared splice+remap primitive behind
  both mention insertion and dictated-text insertion

## Data flow

The browser records through `voiceRecorder.ts`, encodes 16 kHz mono WAV client-side (so the bridge
needs no ffmpeg), and on stop sends `{ type: 'transcribe', requestId, audio, language?, translate? }`
over the existing WebSocket — the same encrypted path a `prompt` rides, because dictated audio is
as sensitive as typed text (see [end-to-end-encryption](end-to-end-encryption.md)). The bridge
validates size and WAV framing, resolves the model `pickWhisperModel` says the language needs,
runs `whisper-cli -m <model> -f <wav> -nt -np -l <language> [-tr]` behind a one-request-at-a-time
queue, and answers `{ type: 'transcription', requestId, text }` or `{ ..., error }` on the asking
link only. The composer inserts `text` via `MentionInputHandle.insertText`, which reuses
`insertAtCaret` (the same primitive mention-completion uses) so an @mention pill before the caret
shifts rather than getting cut through.

**Model download.** `installWhisperModel { file }` (owner only) starts `whisperModel.ts` streaming
that file into `<app root>/models/`; progress broadcasts as `whisperModelDownload` to every link,
and success re-probes `whisperCli.ts` and re-broadcasts `cliStatus` immediately rather than waiting
for the 15s poll `settings-updates-pane` already runs.

**Shared machine.** Whisper runs on the machine hosting the session, not the device recording —
a phone recording into a host's session sends audio phone → hub → host bridge, and the host's
`whisper-cli` transcribes it; the phone needs nothing installed. `cliStatus`/`hello` send `whisper`
to a guest too (unlike `claudeCli`/`codexCli`, which are owner-only), because the mic button has
to reflect the *host's* install. A guest may `transcribe` iff they hold the `prompt` capability —
transcription only fills the composer, so a guest whose prompts need approval still goes through
approval staging when they press Send.

## Business rules

- `transcribe` needs the `prompt` capability, not a session grant — nothing in the message names a
  session, and dictating is exactly as privileged as typing
- `installWhisperModel` is owner-only, permanently — it writes into the host's app data folder
- an English-only model is always run with `-l en` and never asked to translate, regardless of the
  language or translate flag requested — it can do neither
- a named non-English language (or translate) with only the English-only model installed is
  refused rather than silently mistranscribed; `auto` with nothing installed but the English model
  falls back to it
- one transcription and one model download run at a time per bridge; the audio may be a guest's
  but the CPU is the host's
- recordings longer than `VOICE_MAX_SECONDS` (90s) auto-stop and are transcribed as caught
- a model download is refused while `LINES_WHISPER_MODEL` pins a single external model file
- an iOS home-screen app asks for the mic on every recording: WebKit does not keep the grant once
  the tracks stop, and standalone apps have no per-site permission setting. In a Safari tab,
  aA → Website Settings → Microphone → Allow makes it stick. Holding the stream open between
  recordings would stop the prompts but keep iOS's mic indicator lit, so it is not done

## Architectural rules

- voice input is not a `ProviderCapabilities` field — the prompt reaches either provider as plain
  text either way, so it is not a per-provider concern
- `insertAtCaret` is the one place text is spliced into a `MentionValue` and its ranges remapped;
  mention completion and voice insertion both call it rather than duplicating the range math
- the model a recording uses is decided twice by the same rule (`pickWhisperModel` server-side,
  `whisperModelFor` shared) rather than the client asking the bridge — so the mic's warning and the
  Settings row never have to round-trip to agree with what will actually run
- the downloaded model is only renamed into place after its byte count matches the announced
  `content-length` and its header carries ggml's magic number — a half-written or HTML-error-page
  file can never reach the path `whisperCli.ts` treats as ready

## Tests

- `server/src/whisperCli.test.ts` — binary discovery order (bundled → pinned → Homebrew → PATH),
  installed-model discovery, `pickWhisperModel`'s language rules
- `server/src/transcribe.test.ts` — language/translate flags reaching whisper, the English-only
  fallback, oversize/non-WAV/queue-cap refusals, timeout and cleanup
- `server/src/whisperModel.test.ts` — a complete download, an HTTP error, a truncated download, a
  non-model response — each checked against the `.part` file and the final path

## Related decisions

- local whisper.cpp over a hosted STT API: private, no API key, and the same code path works on
  browser, phone and desktop
- the dictation language decides the model rather than offering a model picker — only two files
  exist to choose between (English-only, and one multilingual model), so a separate model choice
  would only let someone pick the wrong one
- auto-download deferred no further than the model: the binary is bundled on desktop but still a
  manual `brew install` on any other machine, since a whisper.cpp release also needs `cmake` to
  build reproducibly at install time
