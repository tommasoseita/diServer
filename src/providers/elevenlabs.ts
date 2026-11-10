import { bytesToBase64, errorMessage, pcmToWav, redactSecrets, withTimeout } from "../util";
import { fetchConnector, type BatchOptions, type RealtimeOptions, type StreamingTranscriber, type TranscriptResult, type WebSocketLike } from "./mistral";

/**
 * ElevenLabs Scribe v2 transcription, done the way diVoice does it in personal mode:
 * - batch: multipart POST /v1/speech-to-text with the key in `xi-api-key`; 16 kHz audio goes as
 *   raw PCM (`file_format=pcm_s16le_16`, faster than a WAV file); the vocabulary goes in repeated
 *   `keyterms` fields, at most 100 (beyond that each request is billed at least 20 seconds);
 * - realtime: WebSocket /v1/speech-to-text/realtime with the settings in the URL (`model_id`,
 *   `audio_format=pcm_16000`, `commit_strategy=manual`, `language_code`, repeated `keyterms`, at
 *   most 50 of 20 characters); audio in `input_audio_chunk` messages, then an empty chunk with
 *   `commit: true` when the audio ends; the transcript is the `committed_transcript` segments
 *   joined, complete at the first one after the commit.
 *
 * Errors come as their own message types (auth_error, quota_exceeded, input_error...).
 */

const FORBIDDEN = /[<>{}[\]\\]/g;

/**
 * Keyterms the API accepts: no `<>{}[]\`, at most `maxLength` characters and 5 words, no
 * duplicates (ignoring case), at most `limit` of them, in order.
 */
export function keyterms(terms: string[], limit: number, maxLength: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    if (out.length >= limit) break;
    const clean = term.replace(FORBIDDEN, "").trim();
    if (!clean || [...clean].length > maxLength || clean.split(/\s+/).length > 5) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/** Waiting for the transcript after the commit: longer recordings take a little longer. */
export function realtimeFinishTimeoutMs(audioMs: number): number {
  return 4_000 + audioMs / 30;
}

/** Error message types: `auth_error`, `quota_exceeded`, `rate_limited`, `queue_overflow`... */
function isError(type: string): boolean {
  return (
    /(error|exceeded|limited|exhausted|overflow|throttled|terms)$/.test(type) ||
    type === "insufficient_audio_activity" ||
    type === "invalid_request"
  );
}

export function openRealtime(options: RealtimeOptions): StreamingTranscriber {
  return new ElevenLabsRealtime(options);
}

class ElevenLabsRealtime implements StreamingTranscriber {
  private ws: WebSocketLike | undefined;
  private started = false;
  private pending: string[] = [];
  private committed: string[] = [];
  private settled = false;
  private finished = false;
  private readonly startedAt: number;
  private resolveDone!: (result: TranscriptResult) => void;
  private rejectDone!: (error: Error) => void;
  private readonly done: Promise<TranscriptResult>;
  connectMs: number | undefined;

  constructor(private readonly options: RealtimeOptions) {
    this.startedAt = this.now();
    this.done = new Promise<TranscriptResult>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    this.done.catch(() => undefined);
    void this.connect();
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** The WebSocket URL, with every setting in the query. */
  static url(options: Pick<RealtimeOptions, "baseUrl" | "model" | "sampleRate" | "language" | "contextBias">): string {
    const query = new URLSearchParams([
      ["model_id", options.model],
      ["audio_format", `pcm_${options.sampleRate}`],
      ["commit_strategy", "manual"],
    ]);
    if (options.language) query.append("language_code", options.language);
    for (const term of keyterms(options.contextBias, 50, 20)) query.append("keyterms", term);
    return `${options.baseUrl}/v1/speech-to-text/realtime?${query}`;
  }

  private async connect(): Promise<void> {
    try {
      const ws = await (this.options.connect ?? fetchConnector)(ElevenLabsRealtime.url(this.options), { "xi-api-key": this.options.apiKey });
      this.ws = ws;
      if (this.settled) {
        ws.close(1000, "session closed");
        return;
      }
      ws.addEventListener("message", (event) => this.onMessage(event.data));
      ws.addEventListener("close", (event) =>
        this.fail(new Error(`realtime: connection closed (${event.code ?? "?"}) ${event.reason ?? ""}`.trim())),
      );
      ws.addEventListener("error", () => this.fail(new Error("realtime: WebSocket error")));
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(errorMessage(err)));
    }
  }

  private onMessage(data: unknown): void {
    let message: Record<string, unknown>;
    try {
      const raw = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof message.message_type === "string" ? message.message_type : "";
    switch (type) {
      case "session_started":
        this.start();
        return;
      case "committed_transcript":
      case "committed_transcript_with_timestamps": {
        const segment = typeof message.text === "string" ? message.text.trim() : "";
        if (segment) {
          this.committed.push(segment);
          const text = this.committed.join(" ");
          this.options.onDelta?.(segment, text);
        }
        if (this.finished && !this.settled) {
          this.settled = true;
          this.resolveDone({ text: this.committed.join(" "), language: null });
          this.ws?.close(1000, "done");
        }
        return;
      }
      case "partial_transcript":
      case "warning":
        return;
      default:
        if (isError(type)) {
          const detail = typeof message.error === "string" ? message.error : typeof message.message === "string" ? message.message : "";
          this.fail(new Error(redactSecrets(`realtime: ${detail ? `${type}: ${detail}` : type}`)));
        }
    }
  }

  /** The session exists: what was queued goes out. */
  private start(): void {
    if (!this.ws || this.started || this.settled) return;
    this.started = true;
    this.connectMs = this.now() - this.startedAt;
    for (const message of this.pending) this.ws.send(message);
    this.pending = [];
  }

  private sendOrQueue(message: string): void {
    if (this.started && this.ws) this.ws.send(message);
    else this.pending.push(message);
  }

  private chunk(audio: Uint8Array, commit: boolean): string {
    return JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: bytesToBase64(audio), commit, sample_rate: this.options.sampleRate });
  }

  sendAudio(chunk: Uint8Array): void {
    if (this.settled || this.finished || chunk.length === 0) return;
    this.sendOrQueue(this.chunk(chunk, false));
  }

  finish(timeoutMs: number): Promise<TranscriptResult> {
    if (!this.settled && !this.finished) {
      this.finished = true;
      this.sendOrQueue(this.chunk(new Uint8Array(0), true));
    }
    return withTimeout(this.done, timeoutMs, "realtime").catch((err: unknown) => {
      this.abort();
      throw err;
    });
  }

  abort(): void {
    this.fail(new Error("realtime: session cancelled"));
  }

  private fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectDone(error);
    try {
      this.ws?.close(1000, "done");
    } catch {
      // already closed
    }
  }
}

export const realtimeUrl = ElevenLabsRealtime.url;

/** One upload: raw PCM at 16 kHz, a WAV file otherwise. */
export async function batchTranscribe(options: BatchOptions): Promise<TranscriptResult> {
  const form = new FormData();
  form.append("model_id", options.model);
  if (options.pcm && options.sampleRate === 16_000) {
    form.append("file_format", "pcm_s16le_16");
    form.append("file", new Blob([options.pcm as unknown as ArrayBuffer], { type: "application/octet-stream" }), "audio.pcm");
  } else {
    const wav = options.wav ?? pcmToWav(options.pcm ?? new Uint8Array(0), options.sampleRate ?? 16_000);
    form.append("file", new Blob([wav as unknown as ArrayBuffer], { type: "audio/wav" }), "audio.wav");
  }
  if (options.language) form.append("language_code", options.language);
  form.append("tag_audio_events", "false");
  for (const term of keyterms(options.contextBias, 100, 50)) form.append("keyterms", term);

  const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl}/v1/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": options.apiKey },
    body: form,
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(redactSecrets(`batch: HTTP ${response.status} ${body.slice(0, 300)}`));
  }
  const json = (await response.json()) as { text?: string; language_code?: string | null };
  // ElevenLabs answers ISO 639-3 ("ita"); the apps use two letters, as diVoice does.
  return { text: json.text ?? "", language: json.language_code ? json.language_code.slice(0, 2) : null };
}
