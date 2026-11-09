import type { Env, User } from "./env";
import { providerKey } from "./keys";
import { providerBaseUrl, relayChat, sanitizeChatBody, type ChatRelayResult } from "./providers/chat";
import type { BatchOptions, RealtimeOptions, StreamingTranscriber, TranscriptResult } from "./providers/mistral";
import { SAMPLE_RATES, type ChatRole, type OrgSettings } from "./settings";
import { cleanTimings, label, type StatsInput } from "./stats";
import { concatBytes, errorMessage, isDay, pcmDurationMs, pcmToWav, redactSecrets, wordCount } from "./util";

/**
 * One dictation through the organization's server, on one WebSocket.
 *
 * The app keeps the prompts and the logic; the server holds the keys and the models,
 * keeps a copy of the audio (so the batch transcription at release starts here, with no
 * second upload) and relays the app's cleanup or Scribe request on the same connection.
 *
 * App → server:
 *   {"type":"start", sessionId, sampleRate, language, vocabulary, purpose: "dictation"|"verify"}
 *   binary frames: PCM s16le mono at sampleRate
 *   {"type":"finish"}
 *   {"type":"chat", id, role: "cleanup"|"scribe", body}      the provider request, built by the app
 *   {"type":"stats", mode, category, words, localDay, typingWPM, cleanupPath, timings}
 *   {"type":"cancel"} | {"type":"ping"}
 * Server → app:
 *   {"type":"ready", sessionId, sampleRate}
 *   {"type":"partial", text}
 *   {"type":"transcript", text, path, model, language, warning, timings}
 *   {"type":"chat.line", id, line} ... {"type":"chat.done", id} | {"type":"chat.error", id, status, body}
 *   {"type":"error", code, message}, then the server closes
 */

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RelayDeps {
  now(): number;
  settings(): Promise<OrgSettings>;
  key(provider: "mistral" | "openai"): Promise<string | undefined>;
  baseUrl(provider: "mistral" | "openai"): string;
  openRealtime(options: RealtimeOptions): StreamingTranscriber;
  batchTranscribe(options: BatchOptions): Promise<TranscriptResult>;
  fetchImpl?: typeof fetch;
  record(stats: StatsInput): void;
  /** Opens a connection to the provider ahead of the requests at release (best effort). */
  warm?(baseUrl: string): void;
}

export function relayDeps(env: Env, extra: Pick<RelayDeps, "openRealtime" | "batchTranscribe" | "record" | "settings" | "warm">): RelayDeps {
  return {
    now: () => Date.now(),
    key: (provider) => providerKey(env, provider),
    baseUrl: (provider) => providerBaseUrl(env, provider),
    ...extra,
  };
}

type TranscriptionPath = "realtime" | "batch" | "batch_fallback" | "realtime_fallback" | "none";

const MAX_AUDIO_SECONDS = 600;
const MIN_AUDIO_MS = 250;
const REALTIME_DONE_TIMEOUT_MS = 4_000;
const MAX_CHATS = 4;
const CHAT_TIMEOUT_MS: Record<ChatRole, number> = { cleanup: 20_000, scribe: 90_000 };
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANGUAGE = /^[a-z]{2}$/;

class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function toBytes(data: ArrayBuffer | ArrayBufferView | Blob): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof (data as Blob).arrayBuffer === "function") return new Uint8Array(await (data as Blob).arrayBuffer());
  throw new ProtocolError("bad_message", "unrecognized binary frame");
}

/** The dictionary terms the app sends for transcription bias: at most 150 terms, 3000 characters. */
export function parseVocabulary(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  let chars = 0;
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const term = raw.trim().slice(0, 100);
    if (!term || out.length >= 150 || chars + term.length > 3_000) continue;
    out.push(term);
    chars += term.length;
  }
  return out;
}

export class RelaySession {
  private state: "idle" | "started" | "finishing" | "transcribed" | "closed" = "idle";
  private queue: Promise<void> = Promise.resolve();
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private settings: OrgSettings | undefined;
  private apiKey = "";
  private transcriber: StreamingTranscriber | undefined;
  private sampleRate = 16_000;
  private language: string | undefined;
  private vocabulary: string[] = [];
  private verify = false;
  private sessionId: string = crypto.randomUUID();
  private chats = 0;
  private raw = "";
  private path: TranscriptionPath = "none";
  private stats: Partial<StatsInput> | undefined;
  private recorded = false;
  private failure: string | null = null;
  private readonly timings: Record<string, number> = {};

  constructor(
    private readonly socket: SocketLike,
    private readonly user: User,
    private readonly deps: RelayDeps,
  ) {}

  /** In order: audio arriving while the session starts waits in the queue. */
  handle(data: string | ArrayBuffer | ArrayBufferView | Blob): Promise<void> {
    this.queue = this.queue.then(() => this.process(data)).catch((err: unknown) => this.fail(err));
    return this.queue;
  }

  onSocketClosed(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.transcriber?.abort();
    this.recordOnce();
  }

  private send(message: Record<string, unknown>): void {
    if (this.state === "closed") return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      this.onSocketClosed();
    }
  }

  private close(reason: string): void {
    if (this.state === "closed") return;
    this.onSocketClosed();
    try {
      this.socket.close(1000, reason);
    } catch {
      // already closed
    }
  }

  private async process(data: string | ArrayBuffer | ArrayBufferView | Blob): Promise<void> {
    if (this.state === "closed") return;
    if (typeof data !== "string") {
      this.onAudio(await toBytes(data));
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new ProtocolError("bad_message", "invalid message");
    }
    switch (message.type) {
      case "start":
        return this.onStart(message);
      case "finish":
        return this.onFinish();
      case "chat":
        // Not queued behind other chats' streams: the transcript is already there.
        void this.onChat(message).catch((err: unknown) => this.fail(err));
        return;
      case "stats":
        this.onStats(message);
        return;
      case "cancel":
        this.transcriber?.abort();
        this.close("cancelled");
        return;
      case "ping":
        this.send({ type: "pong" });
        return;
      default:
        return;
    }
  }

  private async onStart(message: Record<string, unknown>): Promise<void> {
    if (this.state !== "idle") throw new ProtocolError("bad_state", "session already started");
    this.state = "started";
    if (typeof message.sessionId === "string" && SESSION_ID.test(message.sessionId)) this.sessionId = message.sessionId.toLowerCase();
    this.verify = message.purpose === "verify";
    this.language = typeof message.language === "string" && LANGUAGE.test(message.language) ? message.language : undefined;
    this.vocabulary = parseVocabulary(message.vocabulary);

    const settings = await this.deps.settings();
    this.settings = settings;
    // Verify of a chat model alone: no audio, no transcription stream.
    if (this.verify && message.sampleRate === undefined) {
      this.send({ type: "ready", sessionId: this.sessionId, sampleRate: null });
      return;
    }
    const transcription = settings.pipeline.transcription;
    this.sampleRate = SAMPLE_RATES[transcription.provider];
    if (message.sampleRate !== this.sampleRate) {
      throw new ProtocolError("sample_rate", `the organization's transcription needs ${this.sampleRate} Hz audio: update diVoice`);
    }
    const key = await this.deps.key(transcription.provider);
    if (!key) throw new ProtocolError("no_key", `your organization has no ${transcription.provider === "mistral" ? "Mistral" : "OpenAI"} key yet: ask your admin`);
    this.apiKey = key;
    // While the user speaks: the batch transcription and the cleanup at release find the
    // connection to the provider already open.
    const providers = new Set([transcription.provider, settings.pipeline.cleanup.provider]);
    for (const provider of providers) this.deps.warm?.(this.deps.baseUrl(provider));

    if (transcription.mode !== "batch") {
      this.transcriber = this.deps.openRealtime({
        baseUrl: this.deps.baseUrl(transcription.provider),
        apiKey: key,
        model: transcription.realtimeModel,
        delayMs: transcription.delayMs,
        sampleRate: this.sampleRate,
        language: this.language,
        contextBias: this.vocabulary,
        onDelta: (_delta, accumulated) => this.send({ type: "partial", text: accumulated }),
        now: this.deps.now,
      });
    }
    this.send({ type: "ready", sessionId: this.sessionId, sampleRate: this.sampleRate });
  }

  private onAudio(chunk: Uint8Array): void {
    if (this.state !== "started") return;
    if (this.bytes + chunk.length > MAX_AUDIO_SECONDS * this.sampleRate * 2) {
      throw new ProtocolError("audio_too_long", "recording too long (10 minutes at most)");
    }
    // Copy: the runtime may reuse the message's buffer.
    const copy = chunk.slice();
    this.chunks.push(copy);
    this.bytes += copy.length;
    this.transcriber?.sendAudio(copy);
  }

  private batch(audioMs: number): Promise<TranscriptResult> {
    const transcription = this.settings!.pipeline.transcription;
    return this.deps.batchTranscribe({
      baseUrl: this.deps.baseUrl(transcription.provider),
      apiKey: this.apiKey,
      model: transcription.batchModel,
      wav: pcmToWav(concatBytes(this.chunks, this.bytes), this.sampleRate),
      language: this.language,
      contextBias: this.vocabulary,
      timeoutMs: 20_000 + audioMs / 4,
      fetchImpl: this.deps.fetchImpl,
    });
  }

  /** Same rules as the app: batch first up to batchMaxAudioMs in hybrid mode, each path the other's fallback. */
  private async transcribe(audioMs: number): Promise<{ result: TranscriptResult; path: TranscriptionPath; warning?: string }> {
    const transcription = this.settings!.pipeline.transcription;
    const transcriber = this.transcriber;

    if (!transcriber || (transcription.mode === "hybrid" && audioMs <= transcription.batchMaxAudioMs)) {
      const backup = transcriber?.finish(REALTIME_DONE_TIMEOUT_MS);
      backup?.catch(() => undefined);
      try {
        const result = await this.batch(audioMs);
        transcriber?.abort();
        return { result, path: "batch" };
      } catch (err) {
        if (!backup) throw err;
        const warning = errorMessage(err);
        try {
          const result = await backup;
          if (transcriber?.connectMs !== undefined) this.timings.upstreamConnectMs = transcriber.connectMs;
          return { result, path: "realtime_fallback", warning };
        } catch (err2) {
          throw new Error(`${warning}; ${errorMessage(err2)}`);
        }
      }
    }

    let warning: string | undefined;
    try {
      const result = await transcriber.finish(REALTIME_DONE_TIMEOUT_MS);
      if (transcriber.connectMs !== undefined) this.timings.upstreamConnectMs = transcriber.connectMs;
      if (result.text.trim() || audioMs < 1_500) return { result, path: "realtime" };
      warning = "realtime: empty transcript";
    } catch (err) {
      warning = errorMessage(err);
    }
    try {
      const result = await this.batch(audioMs);
      return { result, path: "batch_fallback", warning };
    } catch (err) {
      throw new Error(`${warning}; ${errorMessage(err)}`);
    }
  }

  private async onFinish(): Promise<void> {
    if (this.state !== "started") throw new ProtocolError("bad_state", "session not started");
    this.state = "finishing";
    const transcription = this.settings!.pipeline.transcription;
    const endedAt = this.deps.now();
    const audioMs = pcmDurationMs(this.bytes, this.sampleRate);
    this.timings.audioMs = audioMs;

    let result: TranscriptResult = { text: "" };
    let warning: string | undefined;
    if (audioMs >= MIN_AUDIO_MS) {
      try {
        const t = await this.transcribe(audioMs);
        result = t.result;
        this.path = t.path;
        warning = t.warning;
      } catch (err) {
        throw new ProtocolError("transcription_failed", `transcription failed: ${errorMessage(err)}`);
      }
    } else {
      this.transcriber?.abort();
    }
    this.timings.transcribeMs = this.deps.now() - endedAt;
    if (this.state !== "finishing") return; // the app disconnected
    this.state = "transcribed";
    this.raw = result.text.trim();
    this.send({
      type: "transcript",
      text: this.raw,
      path: this.path,
      model: this.path.startsWith("realtime") ? transcription.realtimeModel : transcription.batchModel,
      language: result.language ?? null,
      warning: warning ? redactSecrets(warning) : null,
      timings: this.timings,
    });
  }

  private async onChat(message: Record<string, unknown>): Promise<void> {
    const id = typeof message.id === "number" && Number.isInteger(message.id) ? message.id : 0;
    const role = message.role === "scribe" ? "scribe" : message.role === "cleanup" ? "cleanup" : undefined;
    // Only inside a dictation that produced a transcript (or a Verify), a few times.
    const allowed = this.state === "transcribed" || (this.verify && this.state !== "closed");
    if (!role || !allowed || this.chats >= MAX_CHATS) {
      this.send({ type: "chat.error", id, status: 400, body: "chat not allowed in this session" });
      return;
    }
    this.chats++;
    const settings = (this.settings ?? (await this.deps.settings())).pipeline[role];
    let result: ChatRelayResult;
    const keyStarted = this.deps.now();
    let keyMs = 0;
    try {
      const key = await this.deps.key(settings.provider);
      keyMs = this.deps.now() - keyStarted;
      if (!key) {
        this.send({ type: "chat.error", id, status: 503, body: `your organization has no ${settings.provider === "mistral" ? "Mistral" : "OpenAI"} key yet: ask your admin` });
        return;
      }
      const body = sanitizeChatBody(message.body, settings, role);
      result = await relayChat({
        baseUrl: this.deps.baseUrl(settings.provider),
        apiKey: key,
        body,
        timeoutMs: CHAT_TIMEOUT_MS[role],
        fetchImpl: this.deps.fetchImpl,
        onLine: (line) => this.send({ type: "chat.line", id, line }),
      });
    } catch (err) {
      this.send({ type: "chat.error", id, status: 502, body: redactSecrets(errorMessage(err)) });
      return;
    }
    const timings = { keyMs, ...result.timings };
    if (result.ok) this.send({ type: "chat.done", id, timings });
    else this.send({ type: "chat.error", id, status: result.status, body: result.body, timings });
  }

  private onStats(message: Record<string, unknown>): void {
    const words = typeof message.words === "number" && Number.isFinite(message.words) ? Math.max(0, Math.min(100_000, Math.round(message.words))) : undefined;
    const typingWPM = typeof message.typingWPM === "number" && message.typingWPM >= 5 && message.typingWPM <= 300 ? Math.round(message.typingWPM) : null;
    this.stats = {
      mode: message.mode === "scribe" ? "scribe" : "dictation",
      category: label(message.category),
      words,
      localDay: isDay(message.localDay) ? message.localDay : null,
      typingWPM,
      cleanupPath: label(message.cleanupPath),
      clientTimings: cleanTimings(message.timings),
      error: typeof message.error === "string" ? message.error : null,
    };
  }

  /** Once per session, when it closes: counts only, never text. Verify sessions aren't recorded. */
  private recordOnce(): void {
    if (this.recorded || this.verify || this.state === "idle" || this.bytes === 0) return;
    this.recorded = true;
    const s = this.stats ?? {};
    this.deps.record({
      sessionId: this.sessionId,
      mode: s.mode ?? "dictation",
      category: s.category ?? null,
      words: s.words ?? wordCount(this.raw),
      audioMs: pcmDurationMs(this.bytes, this.sampleRate),
      localDay: s.localDay ?? null,
      typingWPM: s.typingWPM ?? null,
      transcriptionPath: this.path,
      cleanupPath: s.cleanupPath ?? null,
      serverTimings: this.timings,
      clientTimings: s.clientTimings ?? {},
      error: this.failure ?? s.error ?? null,
    });
  }

  private fail(err: unknown): void {
    this.transcriber?.abort();
    const code = err instanceof ProtocolError ? err.code : "internal";
    const message = redactSecrets(errorMessage(err));
    this.failure = `${code}: ${message}`;
    this.send({ type: "error", code, message });
    this.close("error");
  }
}

export function acceptRelay(user: User, deps: RelayDeps): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  const session = new RelaySession(server, user, deps);
  server.addEventListener("message", (event) => {
    void session.handle(event.data as string | ArrayBuffer | Blob);
  });
  server.addEventListener("close", () => session.onSocketClosed());
  server.addEventListener("error", () => session.onSocketClosed());
  return new Response(null, { status: 101, webSocket: client });
}
