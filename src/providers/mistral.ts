import { bytesToBase64, errorMessage, redactSecrets, withTimeout } from "../util";

/**
 * Mistral transcription: streaming (Voxtral realtime, WebSocket) and batch (one file).
 *
 * Streaming protocol:
 *   server → session.created
 *   client → session.update { session: { audio_format, target_streaming_delay_ms, context_bias, language } }
 *   client → input_audio.append { audio: base64 } ...
 *   server → transcription.text.delta { text }
 *   client → input_audio.flush, input_audio.end
 *   server → transcription.done { text, language }
 * Session fields lock at the first audio, so audio waits until session.update has gone out.
 */

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
}

export type WebSocketConnector = (url: string, headers: Record<string, string>) => Promise<WebSocketLike>;

/** Outgoing WebSocket from a Worker: fetch with the Upgrade header. */
export const fetchConnector: WebSocketConnector = async (url, headers) => {
  const response = await fetch(url, { headers: { ...headers, Upgrade: "websocket" } });
  const ws = response.webSocket;
  if (!ws) {
    const body = await response.text().catch(() => "");
    throw new Error(redactSecrets(`realtime: connection refused (HTTP ${response.status}) ${body.slice(0, 300)}`));
  }
  ws.accept();
  return ws as unknown as WebSocketLike;
};

export interface TranscriptResult {
  text: string;
  language?: string | null;
}

export interface StreamingTranscriber {
  sendAudio(chunk: Uint8Array): void;
  /** Ends the audio and waits for the final transcript. */
  finish(timeoutMs: number): Promise<TranscriptResult>;
  abort(): void;
  /** Milliseconds from opening to session.update, once sent. */
  readonly connectMs: number | undefined;
}

export interface RealtimeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  delayMs: number;
  sampleRate: number;
  language?: string;
  contextBias: string[];
  onDelta?: (delta: string, accumulated: string) => void;
  connect?: WebSocketConnector;
  now?: () => number;
}

export function openRealtime(options: RealtimeOptions): StreamingTranscriber {
  return new RealtimeSession(options);
}

function describeError(error: unknown): string {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const e = error as Record<string, unknown>;
    const message = typeof e.message === "string" ? e.message : JSON.stringify(e.message ?? e);
    return e.code !== undefined ? `${message} (${String(e.code)})` : message;
  }
  return String(error);
}

class RealtimeSession implements StreamingTranscriber {
  private ws: WebSocketLike | undefined;
  private configured = false;
  private pending: string[] = [];
  private text = "";
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

  private async connect(): Promise<void> {
    const { baseUrl, apiKey, model } = this.options;
    const url = `${baseUrl}/v1/audio/transcriptions/realtime?model=${encodeURIComponent(model)}`;
    try {
      const ws = await (this.options.connect ?? fetchConnector)(url, { Authorization: `Bearer ${apiKey}` });
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
    switch (message.type) {
      case "session.created":
        this.configure();
        break;
      case "transcription.text.delta": {
        const delta = typeof message.text === "string" ? message.text : "";
        if (delta) {
          this.text += delta;
          this.options.onDelta?.(delta, this.text);
        }
        break;
      }
      case "transcription.done": {
        if (this.settled) return;
        this.settled = true;
        const text = typeof message.text === "string" ? message.text : this.text;
        const language = typeof message.language === "string" ? message.language : null;
        this.resolveDone({ text, language });
        this.ws?.close(1000, "done");
        break;
      }
      case "error":
        this.fail(new Error(redactSecrets(`realtime: ${describeError(message.error)}`)));
        break;
      default:
        break;
    }
  }

  private configure(): void {
    if (!this.ws || this.configured || this.settled) return;
    const session: Record<string, unknown> = {
      audio_format: { encoding: "pcm_s16le", sample_rate: this.options.sampleRate },
      target_streaming_delay_ms: this.options.delayMs,
    };
    if (this.options.contextBias.length > 0) session.context_bias = this.options.contextBias;
    if (this.options.language) session.language = this.options.language;
    this.ws.send(JSON.stringify({ type: "session.update", session }));
    this.configured = true;
    this.connectMs = this.now() - this.startedAt;
    for (const message of this.pending) this.ws.send(message);
    this.pending = [];
  }

  private sendOrQueue(message: string): void {
    if (this.configured && this.ws) this.ws.send(message);
    else this.pending.push(message);
  }

  sendAudio(chunk: Uint8Array): void {
    if (this.settled || this.finished || chunk.length === 0) return;
    this.sendOrQueue(JSON.stringify({ type: "input_audio.append", audio: bytesToBase64(chunk) }));
  }

  finish(timeoutMs: number): Promise<TranscriptResult> {
    if (!this.settled && !this.finished) {
      this.finished = true;
      this.sendOrQueue(JSON.stringify({ type: "input_audio.flush" }));
      this.sendOrQueue(JSON.stringify({ type: "input_audio.end" }));
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

export interface BatchOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  wav: Uint8Array;
  language?: string;
  contextBias: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** One file: multipart POST to /v1/audio/transcriptions; context_bias repeats once per term. */
export async function batchTranscribe(options: BatchOptions): Promise<TranscriptResult> {
  const form = new FormData();
  form.append("model", options.model);
  form.append("file", new Blob([options.wav as unknown as ArrayBuffer], { type: "audio/wav" }), "audio.wav");
  if (options.language) form.append("language", options.language);
  for (const term of options.contextBias) form.append("context_bias", term);

  const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(redactSecrets(`batch: HTTP ${response.status} ${body.slice(0, 300)}`));
  }
  const json = (await response.json()) as { text?: string; language?: string | null };
  return { text: json.text ?? "", language: json.language ?? null };
}
