/**
 * Microphone capture for voice input, encoded the way the bridge's whisper.cpp
 * reads it: 16 kHz, mono, 16-bit PCM WAV, as raw base64.
 *
 * Encoded here rather than on the bridge so the bridge needs no ffmpeg. The
 * context runs at the device's own rate — Firefox refuses to connect a mic to an
 * AudioContext at any other — and the samples are downsampled once, at the end.
 */
import { VOICE_MAX_SECONDS } from '@lines/shared';

const TARGET_RATE = 16_000;

/** `getUserMedia` only exists on a secure context (https, or localhost). On a
 *  plain-http LAN address there is no way to ask, so the button is not offered. */
export function voiceInputSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof AudioContext !== 'undefined'
  );
}

export interface VoiceRecording {
  /** Stop and resolve with the recording as raw base64 WAV. */
  stop: () => Promise<string>;
  /** Stop and throw the audio away. */
  cancel: () => void;
  /** Loudness right now, 0..1 — RMS of the latest analyser frame, for the
   *  waveform. Cheap enough to call every animation frame. */
  level: () => number;
}

/**
 * Start recording. Rejects when the mic is refused or absent. `onLimit` fires
 * once when {@link VOICE_MAX_SECONDS} is reached; capture has stopped by then,
 * and the caller is expected to `stop()`.
 */
export async function startVoiceRecording({ onLimit }: { onLimit: () => void }): Promise<VoiceRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated but everywhere, and needs no worklet module
  // served beside the bundle. The buffer size only sets callback granularity.
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  const maxSamples = VOICE_MAX_SECONDS * ctx.sampleRate;
  let captured = 0;
  let limited = false;

  processor.onaudioprocess = (e) => {
    if (limited) return;
    const input = e.inputBuffer.getChannelData(0);
    const take = Math.min(input.length, maxSamples - captured);
    chunks.push(input.slice(0, take));
    captured += take;
    if (captured >= maxSamples) {
      limited = true;
      onLimit();
    }
  };
  // A second tap on the mic just for the waveform: the processor above hands
  // over 4096-sample blocks (~85 ms), too coarse to animate from.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const frame = new Float32Array(analyser.fftSize);
  source.connect(analyser);
  source.connect(processor);
  // Some engines only run a processor that reaches the destination; its output
  // buffer is left silent, so nothing is played back.
  processor.connect(ctx.destination);

  const release = () => {
    processor.onaudioprocess = null;
    source.disconnect();
    analyser.disconnect();
    processor.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void ctx.close();
  };

  return {
    stop: async () => {
      release();
      const samples = downsample(concat(chunks, captured), ctx.sampleRate, TARGET_RATE);
      return blobToBase64(encodeWav(samples, TARGET_RATE));
    },
    cancel: release,
    level: () => {
      analyser.getFloatTimeDomainData(frame);
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      return Math.sqrt(sum / frame.length);
    },
  };
}

function concat(chunks: Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Box-filter downsample: each output sample averages the input span it covers,
 *  which is enough anti-aliasing for speech headed to a speech model. */
function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

function encodeWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Raw base64, no `data:` prefix — the wire format `transcribe` expects. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
