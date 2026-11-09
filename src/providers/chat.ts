import type { Env } from "../env";
import { HttpError } from "../errors";
import type { ChatRole, ChatSettings, Provider } from "../settings";
import { redactSecrets } from "../util";

/**
 * The chat relay: the app builds the request (prompts stay in the app) and the server
 * sends it with the organization's key and the model the admin chose for that role.
 * Only the fields the app uses pass through; the rest is dropped.
 */

export function providerBaseUrl(env: Env, provider: Provider): string {
  const configured = provider === "mistral" ? env.MISTRAL_BASE_URL : env.OPENAI_BASE_URL;
  return (configured?.trim() || (provider === "mistral" ? "https://api.mistral.ai" : "https://api.openai.com")).replace(/\/+$/, "");
}

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 60_000;
const MAX_TOTAL_CHARS = 200_000;
const MAX_TOKENS: Record<ChatRole, number> = { cleanup: 8_000, scribe: 12_000 };
const REASONING = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const CACHE_KEY = /^[A-Za-z0-9._:\-]{1,120}$/;

function finite(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

export function sanitizeChatBody(body: unknown, settings: ChatSettings, role: ChatRole): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "chat: a request body is required");
  const o = body as Record<string, unknown>;
  if (!Array.isArray(o.messages) || o.messages.length === 0 || o.messages.length > MAX_MESSAGES) {
    throw new HttpError(400, `chat: 1 to ${MAX_MESSAGES} messages`);
  }
  let total = 0;
  const messages = o.messages.map((raw) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    if (m.role !== "system" && m.role !== "user" && m.role !== "assistant") throw new HttpError(400, "chat: invalid message role");
    if (typeof m.content !== "string" || m.content.length > MAX_MESSAGE_CHARS) throw new HttpError(400, "chat: message too long");
    total += m.content.length;
    return { role: m.role, content: m.content };
  });
  if (total > MAX_TOTAL_CHARS) throw new HttpError(400, "chat: request too long");

  const out: Record<string, unknown> = { model: settings.model, messages, stream: true };
  const limitKey = settings.provider === "mistral" ? "max_tokens" : "max_completion_tokens";
  const requested = finite(o.max_tokens ?? o.max_completion_tokens, 1, 1_000_000);
  out[limitKey] = Math.min(Math.round(requested ?? 1_000), MAX_TOKENS[role]);

  const temperature = finite(o.temperature, 0, 2);
  if (temperature !== undefined) out.temperature = temperature;
  const topP = finite(o.top_p, 0, 1);
  if (topP !== undefined) out.top_p = topP;
  if (typeof o.reasoning_effort === "string" && REASONING.has(o.reasoning_effort)) out.reasoning_effort = o.reasoning_effort;
  if (typeof o.prompt_cache_key === "string" && CACHE_KEY.test(o.prompt_cache_key)) out.prompt_cache_key = o.prompt_cache_key;

  const prediction = o.prediction as { type?: unknown; content?: unknown } | undefined;
  if (settings.prediction && prediction?.type === "content" && typeof prediction.content === "string" && prediction.content.length <= MAX_MESSAGE_CHARS) {
    out.prediction = { type: "content", content: prediction.content };
  }
  if (settings.provider === "openai" && settings.fastTier) out.service_tier = "fast";
  return out;
}

export interface ChatRelayOptions {
  baseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  onLine: (line: string) => void;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Milliseconds from sending the request: response headers, first line of the stream, end. */
export interface ChatRelayTimings {
  headersMs: number;
  firstLineMs?: number;
  totalMs: number;
}

export type ChatRelayResult = ({ ok: true } | { ok: false; status: number; body: string }) & { timings: ChatRelayTimings };

/** Sends the request and passes each line of the provider's event stream to onLine. */
export async function relayChat(options: ChatRelayOptions): Promise<ChatRelayResult> {
  const started = Date.now();
  const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const timings: ChatRelayTimings = { headersMs: Date.now() - started, totalMs: 0 };
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    timings.totalMs = Date.now() - started;
    return { ok: false, status: response.status, body: redactSecrets(text.slice(0, 2_000)), timings };
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        timings.firstLineMs ??= Date.now() - started;
        options.onLine(line);
      }
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) options.onLine(buffer.trim());
  timings.totalMs = Date.now() - started;
  return { ok: true, timings };
}
