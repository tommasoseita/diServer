import * as elevenlabs from "./elevenlabs";
import * as mistral from "./mistral";
import type { BatchOptions, RealtimeOptions, StreamingTranscriber, TranscriptResult } from "./mistral";

/** Transcription by provider: Mistral (Voxtral) or ElevenLabs (Scribe v2). */
export function openRealtime(options: RealtimeOptions): StreamingTranscriber {
  return options.provider === "elevenlabs" ? elevenlabs.openRealtime(options) : mistral.openRealtime(options);
}

export function batchTranscribe(options: BatchOptions): Promise<TranscriptResult> {
  return options.provider === "elevenlabs" ? elevenlabs.batchTranscribe(options) : mistral.batchTranscribe(options);
}
