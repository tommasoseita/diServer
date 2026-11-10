import { describe, expect, it } from "vitest";
import { batchTranscribe, keyterms, openRealtime, realtimeFinishTimeoutMs, realtimeUrl } from "../src/providers/elevenlabs";
import type { WebSocketLike } from "../src/providers/mistral";
import { redactSecrets } from "../src/util";
import { tick } from "./helpers";

class FakeElevenLabsSocket implements WebSocketLike {
  sent: Record<string, any>[] = [];
  closed = false;
  private listeners: Record<string, ((event: any) => void)[]> = {};
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  addEventListener(type: string, listener: (event: any) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(message: Record<string, unknown>) {
    for (const listener of this.listeners.message ?? []) listener({ data: JSON.stringify(message) });
  }
}

function realtime(extra: { language?: string; contextBias?: string[] } = {}) {
  const socket = new FakeElevenLabsSocket();
  const opened: { url: string; headers: Record<string, string> }[] = [];
  const deltas: string[] = [];
  const session = openRealtime({
    provider: "elevenlabs",
    baseUrl: "https://elevenlabs.test",
    apiKey: "sk_test_elevenlabs_0123456789",
    model: "scribe_v2_realtime",
    delayMs: 480,
    sampleRate: 16_000,
    language: extra.language ?? "it",
    contextBias: extra.contextBias ?? ["Zentrix"],
    onDelta: (_delta, text) => deltas.push(text),
    connect: async (url, headers) => {
      opened.push({ url, headers });
      return socket;
    },
  });
  return { socket, opened, deltas, session };
}

describe("keyterms", () => {
  it("keep what ElevenLabs accepts, in order, without duplicates", () => {
    const terms = ["Zentrix", "zentrix", "a{b}", "  Acme  ", "una frase di ben sei parole qui", "x".repeat(25), "", "Rossi"];
    expect(keyterms(terms, 50, 20)).toEqual(["Zentrix", "ab", "Acme", "Rossi"]);
    expect(keyterms(terms, 2, 20)).toEqual(["Zentrix", "ab"]);
    expect(keyterms(["x".repeat(25)], 100, 50)).toEqual(["x".repeat(25)]);
  });
});

describe("ElevenLabs realtime", () => {
  it("puts the settings in the URL, sends the audio after session_started and commits at the end", async () => {
    const terms = Array.from({ length: 60 }, (_, i) => `term${i}`);
    const { socket, opened, deltas, session } = realtime({ contextBias: terms });
    await tick();
    const url = new URL(opened[0]!.url);
    expect(url.origin + url.pathname).toBe("https://elevenlabs.test/v1/speech-to-text/realtime");
    expect(Object.fromEntries([...url.searchParams].filter(([k]) => k !== "keyterms"))).toEqual({
      model_id: "scribe_v2_realtime",
      audio_format: "pcm_16000",
      commit_strategy: "manual",
      language_code: "it",
    });
    expect(url.searchParams.getAll("keyterms")).toHaveLength(50);
    expect(opened[0]!.headers).toEqual({ "xi-api-key": "sk_test_elevenlabs_0123456789" });

    // Audio waits for the session.
    session.sendAudio(new Uint8Array([1, 2, 3, 4]));
    expect(socket.sent).toHaveLength(0);
    socket.emit({ message_type: "session_started", session_id: "s1" });
    expect(socket.sent).toEqual([{ message_type: "input_audio_chunk", audio_base_64: "AQIDBA==", commit: false, sample_rate: 16_000 }]);

    socket.emit({ message_type: "partial_transcript", text: "ciao a" });
    const done = session.finish(5_000);
    expect(socket.sent.at(-1)).toEqual({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: 16_000 });
    socket.emit({ message_type: "committed_transcript", text: "Ciao a tutti." });
    await expect(done).resolves.toEqual({ text: "Ciao a tutti.", language: null });
    expect(deltas).toEqual(["Ciao a tutti."]);
    expect(socket.closed).toBe(true);
  });

  it("joins the segments committed along the way", async () => {
    const { socket, session } = realtime();
    await tick();
    socket.emit({ message_type: "session_started" });
    socket.emit({ message_type: "committed_transcript", text: "Primo pezzo." });
    const done = session.finish(5_000);
    socket.emit({ message_type: "committed_transcript", text: "Secondo." });
    await expect(done).resolves.toMatchObject({ text: "Primo pezzo. Secondo." });
  });

  it("fails on ElevenLabs' error messages, without the key", async () => {
    const { socket, session } = realtime();
    await tick();
    socket.emit({ message_type: "session_started" });
    const done = session.finish(5_000);
    socket.emit({ message_type: "quota_exceeded", error: "no credits left" });
    await expect(done).rejects.toThrow("realtime: quota_exceeded: no credits left");
    expect(redactSecrets('{"xi-api-key": "sk_test_elevenlabs_0123456789"}')).not.toContain("elevenlabs_0123456789");
    expect(realtimeFinishTimeoutMs(60_000)).toBe(6_000);
  });

  it("builds the same URL without a language", () => {
    const url = new URL(realtimeUrl({ baseUrl: "https://e.test", model: "scribe_v2_realtime", sampleRate: 16_000, contextBias: [] }));
    expect(url.searchParams.has("language_code")).toBe(false);
  });
});

describe("ElevenLabs batch", () => {
  async function captured(options: { sampleRate?: number; terms?: string[]; status?: number } = {}) {
    const requests: { url: string; headers: Headers; form: FormData }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, headers: new Headers(init.headers), form: init.body as FormData });
      if (options.status) return new Response("invalid model", { status: options.status });
      return Response.json({ text: "Ciao a tutti.", language_code: "ita", language_probability: 0.99, words: [] });
    }) as unknown as typeof fetch;
    const pcm = new Uint8Array(32_000);
    const result = batchTranscribe({
      provider: "elevenlabs",
      baseUrl: "https://elevenlabs.test",
      apiKey: "sk_test_elevenlabs_0123456789",
      model: "scribe_v2",
      pcm,
      sampleRate: options.sampleRate ?? 16_000,
      language: "it",
      contextBias: options.terms ?? ["Zentrix", "Rossi"],
      fetchImpl,
    });
    return { result, requests };
  }

  it("uploads raw 16 kHz PCM with the vocabulary as keyterms", async () => {
    const terms = Array.from({ length: 120 }, (_, i) => `term${i}`);
    const { result, requests } = await captured({ terms });
    await expect(result).resolves.toEqual({ text: "Ciao a tutti.", language: "it" });
    const { url, headers, form } = requests[0]!;
    expect(url).toBe("https://elevenlabs.test/v1/speech-to-text");
    expect(headers.get("xi-api-key")).toBe("sk_test_elevenlabs_0123456789");
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("file_format")).toBe("pcm_s16le_16");
    expect((form.get("file") as File).size).toBe(32_000);
    expect(form.get("language_code")).toBe("it");
    expect(form.get("tag_audio_events")).toBe("false");
    expect(form.getAll("keyterms")).toHaveLength(100);
  });

  it("sends a WAV file at other sample rates, and reports HTTP errors without the key", async () => {
    const other = await captured({ sampleRate: 24_000 });
    await other.result;
    expect(other.requests[0]!.form.get("file_format")).toBeNull();
    expect((other.requests[0]!.form.get("file") as File).size).toBe(44 + 32_000);

    const failed = await captured({ status: 422 });
    await expect(failed.result).rejects.toThrow("batch: HTTP 422 invalid model");
  });
});
