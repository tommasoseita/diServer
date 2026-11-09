import { describe, expect, it } from "vitest";
import type { User } from "../src/env";
import type { BatchOptions, RealtimeOptions, StreamingTranscriber, TranscriptResult } from "../src/providers/mistral";
import { parseVocabulary, RelaySession, type RelayDeps } from "../src/relay";
import { DEFAULT_PIPELINE, type OrgSettings } from "../src/settings";
import type { StatsInput } from "../src/stats";
import { silence, tick } from "./helpers";

const user: User = { id: "u1", name: "Ada", email: "ada@example.com", role: "member" };

class FakeSocket {
  sent: Record<string, any>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  of(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

class FakeTranscriber implements StreamingTranscriber {
  audio = 0;
  aborted = false;
  connectMs = 120;
  constructor(private readonly result: () => Promise<TranscriptResult>) {}
  sendAudio(chunk: Uint8Array) {
    this.audio += chunk.length;
  }
  finish(): Promise<TranscriptResult> {
    return this.result();
  }
  abort() {
    this.aborted = true;
  }
}

interface Harness {
  socket: FakeSocket;
  session: RelaySession;
  realtime: RealtimeOptions[];
  batches: BatchOptions[];
  transcriber?: FakeTranscriber;
  chats: { url: string; headers: Headers; body: Record<string, any> }[];
  recorded: StatsInput[];
  warmed: string[];
}

function harness(options: {
  settings?: Partial<OrgSettings>;
  realtime?: () => Promise<TranscriptResult>;
  batch?: () => Promise<TranscriptResult>;
  key?: string | undefined;
  chatResponse?: () => Response;
}): Harness {
  const socket = new FakeSocket();
  const h: Harness = { socket, session: undefined as unknown as RelaySession, realtime: [], batches: [], chats: [], recorded: [], warmed: [] };
  const deps: RelayDeps = {
    now: () => 1_000,
    settings: async () => ({ name: "Acme", pipeline: structuredClone(DEFAULT_PIPELINE), leaderboardEnabled: true, ...options.settings }),
    key: async () => ("key" in options ? options.key : "org-key-123"),
    baseUrl: (provider) => (provider === "mistral" ? "https://mistral.test" : "https://openai.test"),
    openRealtime: (o) => {
      h.realtime.push(o);
      h.transcriber = new FakeTranscriber(options.realtime ?? (async () => ({ text: "streaming text" })));
      return h.transcriber;
    },
    batchTranscribe: async (o) => {
      h.batches.push(o);
      return (options.batch ?? (async () => ({ text: "batch text", language: "it" })))();
    },
    fetchImpl: (async (url: string, init: RequestInit) => {
      h.chats.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body as string) });
      if (options.chatResponse) return options.chatResponse();
      const lines = ['data: {"choices":[{"delta":{"content":"Ciao"}}]}', "", 'data: {"choices":[{"delta":{"content":" a tutti."}}]}', "", "data: [DONE]", ""];
      return new Response(lines.join("\n"), { headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch,
    record: (stats) => h.recorded.push(stats),
    warm: (url) => h.warmed.push(url),
  };
  h.session = new RelaySession(socket, user, deps);
  return h;
}

const start = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "start", sessionId: "0b5c8a62-3f1e-4f6a-9d1e-2a7b9c4d5e6f", sampleRate: 16_000, language: "it", vocabulary: ["Zentrix"], ...extra });

describe("transcription", () => {
  it("in hybrid mode uses the batch model on the server's copy of the audio", async () => {
    const h = harness({});
    await h.session.handle(start());
    expect(h.realtime[0]).toMatchObject({ apiKey: "org-key-123", model: "voxtral-mini-transcribe-realtime-3-0", sampleRate: 16_000, language: "it", contextBias: ["Zentrix"] });
    expect(h.socket.of("ready")[0]).toMatchObject({ sampleRate: 16_000 });
    expect(h.warmed).toEqual(["https://mistral.test"]);
    await h.session.handle(silence(1_000));
    await h.session.handle(silence(500));
    await h.session.handle(JSON.stringify({ type: "finish" }));

    expect(h.transcriber!.audio).toBe(48_000);
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]!.wav.length).toBe(44 + 48_000);
    expect(h.batches[0]).toMatchObject({ model: "voxtral-mini-transcribe-3-0", contextBias: ["Zentrix"], language: "it" });
    expect(h.socket.of("transcript")[0]).toMatchObject({ text: "batch text", path: "batch", model: "voxtral-mini-transcribe-3-0", language: "it" });
    expect(h.transcriber!.aborted).toBe(true);
  });

  it("falls back to streaming when the batch call fails, and the other way round", async () => {
    const failingBatch = harness({ batch: async () => Promise.reject(new Error("batch: HTTP 500")) });
    await failingBatch.session.handle(start());
    await failingBatch.session.handle(silence(2_000));
    await failingBatch.session.handle(JSON.stringify({ type: "finish" }));
    expect(failingBatch.socket.of("transcript")[0]).toMatchObject({ text: "streaming text", path: "realtime_fallback", warning: "batch: HTTP 500" });

    const realtime = structuredClone(DEFAULT_PIPELINE);
    realtime.transcription.mode = "realtime";
    const emptyStream = harness({ settings: { pipeline: realtime }, realtime: async () => ({ text: "" }) });
    await emptyStream.session.handle(start());
    await emptyStream.session.handle(silence(2_000));
    await emptyStream.session.handle(JSON.stringify({ type: "finish" }));
    expect(emptyStream.socket.of("transcript")[0]).toMatchObject({ text: "batch text", path: "batch_fallback", warning: "realtime: empty transcript" });
  });

  it("refuses the wrong sample rate and a missing key", async () => {
    const rate = harness({});
    await rate.session.handle(start({ sampleRate: 24_000 }));
    expect(rate.socket.of("error")[0]).toMatchObject({ code: "sample_rate" });
    expect(rate.socket.closed).not.toBeNull();

    const noKey = harness({ key: undefined });
    await noKey.session.handle(start());
    expect(noKey.socket.of("error")[0]!.message).toContain("ask your admin");
  });

  it("skips transcription for very short audio", async () => {
    const h = harness({});
    await h.session.handle(start());
    await h.session.handle(silence(100));
    await h.session.handle(JSON.stringify({ type: "finish" }));
    expect(h.batches).toHaveLength(0);
    expect(h.socket.of("transcript")[0]).toMatchObject({ text: "", path: "none" });
  });
});

describe("chat relay", () => {
  async function transcribed(options: Parameters<typeof harness>[0] = {}) {
    const h = harness(options);
    await h.session.handle(start());
    await h.session.handle(silence(1_000));
    await h.session.handle(JSON.stringify({ type: "finish" }));
    return h;
  }

  it("sends the app's request with the organization's model and key, and streams the lines back", async () => {
    const h = await transcribed();
    const body = {
      model: "something-else",
      messages: [{ role: "system", content: "rules" }, { role: "user", content: "Transcript:\nciao a tutti" }],
      stream: false,
      max_tokens: 100,
      temperature: 0,
      top_p: 1,
      prediction: { type: "content", content: "ciao a tutti" },
      prompt_cache_key: "divoice-cleanup-abc",
      tools: [{ type: "function" }],
      n: 5,
    };
    await h.session.handle(JSON.stringify({ type: "chat", id: 1, role: "cleanup", body }));
    await tick();
    await tick();

    expect(h.chats[0]!.url).toBe("https://mistral.test/v1/chat/completions");
    expect(h.chats[0]!.headers.get("Authorization")).toBe("Bearer org-key-123");
    expect(h.chats[0]!.body).toEqual({
      model: "mistral-small-2603",
      messages: body.messages,
      stream: true,
      max_tokens: 100,
      temperature: 0,
      top_p: 1,
      prediction: { type: "content", content: "ciao a tutti" },
      prompt_cache_key: "divoice-cleanup-abc",
    });
    expect(h.socket.of("chat.line").map((m) => m.line)).toEqual([
      'data: {"choices":[{"delta":{"content":"Ciao"}}]}',
      'data: {"choices":[{"delta":{"content":" a tutti."}}]}',
      "data: [DONE]",
    ]);
    const done = h.socket.of("chat.done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ id: 1, timings: { keyMs: 0 } });
    expect(typeof done[0]!.timings.headersMs).toBe("number");
    expect(typeof done[0]!.timings.firstLineMs).toBe("number");
  });

  it("uses the admin's choices: provider per role, fast tier, prediction off", async () => {
    const pipeline = structuredClone(DEFAULT_PIPELINE);
    pipeline.scribe = { provider: "openai", model: "gpt-6.1-sol", prediction: false, fastTier: true };
    const h = await transcribed({ settings: { pipeline } });
    await h.session.handle(
      JSON.stringify({
        type: "chat",
        id: 2,
        role: "scribe",
        body: { messages: [{ role: "user", content: "write" }], max_completion_tokens: 50_000, prediction: { type: "content", content: "x" }, service_tier: "default" },
      }),
    );
    await tick();
    await tick();
    expect(h.chats[0]!.url).toBe("https://openai.test/v1/chat/completions");
    expect(h.chats[0]!.body).toEqual({
      model: "gpt-6.1-sol",
      messages: [{ role: "user", content: "write" }],
      stream: true,
      max_completion_tokens: 12_000,
      service_tier: "fast",
    });
  });

  it("is refused before a transcript, after a few requests, and with invalid messages", async () => {
    const early = harness({});
    await early.session.handle(start());
    await early.session.handle(JSON.stringify({ type: "chat", id: 1, role: "cleanup", body: { messages: [{ role: "user", content: "hi" }] } }));
    expect(early.socket.of("chat.error")[0]).toMatchObject({ id: 1, status: 400 });
    expect(early.chats).toHaveLength(0);

    const h = await transcribed();
    for (let id = 1; id <= 5; id++) {
      await h.session.handle(JSON.stringify({ type: "chat", id, role: "cleanup", body: { messages: [{ role: "user", content: "hi" }] } }));
      await tick();
      await tick();
    }
    expect(h.chats).toHaveLength(4);
    expect(h.socket.of("chat.error").map((m) => m.id)).toEqual([5]);

    const invalid = await transcribed();
    await invalid.session.handle(JSON.stringify({ type: "chat", id: 9, role: "cleanup", body: { messages: [{ role: "tool", content: "x" }] } }));
    await tick();
    expect(invalid.socket.of("chat.error")[0]).toMatchObject({ id: 9, status: 502 });
  });

  it("reports the provider's error without keys", async () => {
    const h = await transcribed({
      chatResponse: () => new Response('{"error":{"message":"Incorrect API key provided: sk-proj-****1owA."}}', { status: 401 }),
    });
    await h.session.handle(JSON.stringify({ type: "chat", id: 3, role: "cleanup", body: { messages: [{ role: "user", content: "hi" }] } }));
    await tick();
    await tick();
    const error = h.socket.of("chat.error")[0]!;
    expect(error).toMatchObject({ id: 3, status: 401 });
    expect(error.body).not.toContain("sk-");
  });

  it("allows a chat-only Verify without audio", async () => {
    const h = harness({});
    await h.session.handle(JSON.stringify({ type: "start", purpose: "verify" }));
    expect(h.realtime).toHaveLength(0);
    await h.session.handle(JSON.stringify({ type: "chat", id: 1, role: "cleanup", body: { messages: [{ role: "user", content: "test" }] } }));
    await tick();
    await tick();
    expect(h.socket.of("chat.done")).toHaveLength(1);
    h.session.onSocketClosed();
    expect(h.recorded).toHaveLength(0);
  });
});

describe("statistics", () => {
  it("records counts from the app when the session closes, never text", async () => {
    const h = harness({});
    await h.session.handle(start());
    await h.session.handle(silence(2_000));
    await h.session.handle(JSON.stringify({ type: "finish" }));
    await h.session.handle(
      JSON.stringify({ type: "stats", mode: "dictation", category: "workChat", words: 7, localDay: "2026-11-09", typingWPM: 45, cleanupPath: "llm", timings: { cleanupMs: 320, bad: "x" } }),
    );
    h.session.onSocketClosed();
    expect(h.recorded).toHaveLength(1);
    const stats = h.recorded[0]!;
    expect(stats).toMatchObject({
      sessionId: "0b5c8a62-3f1e-4f6a-9d1e-2a7b9c4d5e6f",
      mode: "dictation",
      category: "workChat",
      words: 7,
      audioMs: 2_000,
      localDay: "2026-11-09",
      typingWPM: 45,
      transcriptionPath: "batch",
      cleanupPath: "llm",
      clientTimings: { cleanupMs: 320 },
    });
    expect(JSON.stringify(stats)).not.toContain("batch text");
    h.session.onSocketClosed();
    expect(h.recorded).toHaveLength(1);
  });

  it("falls back to the transcript's word count, and ignores sessions without audio", async () => {
    const h = harness({});
    await h.session.handle(start());
    await h.session.handle(silence(1_000));
    await h.session.handle(JSON.stringify({ type: "finish" }));
    h.session.onSocketClosed();
    expect(h.recorded[0]).toMatchObject({ words: 2, localDay: null });

    const empty = harness({});
    await empty.session.handle(start());
    empty.session.onSocketClosed();
    expect(empty.recorded).toHaveLength(0);
  });
});

describe("vocabulary", () => {
  it("keeps at most 150 terms and 3000 characters", () => {
    expect(parseVocabulary(["  Zentrix ", 3, "", "Orbix"])).toEqual(["Zentrix", "Orbix"]);
    expect(parseVocabulary(Array.from({ length: 200 }, (_, i) => `t${i}`))).toHaveLength(150);
    expect(parseVocabulary(Array.from({ length: 100 }, () => "x".repeat(100))).join("").length).toBeLessThanOrEqual(3_000);
    expect(parseVocabulary("nope")).toEqual([]);
  });
});
