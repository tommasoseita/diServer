import type { Env } from "./env";
import { HttpError } from "./errors";

export type Provider = "mistral" | "openai";
export type TranscriptionMode = "realtime" | "batch" | "hybrid";
export type ChatRole = "cleanup" | "scribe";

/** Same JSON as the app's PipelineSettings, so the app decodes it directly. */
export interface TranscriptionSettings {
  provider: Provider;
  mode: TranscriptionMode;
  realtimeModel: string;
  batchModel: string;
  delayMs: number;
  batchMaxAudioMs: number;
}

export interface ChatSettings {
  provider: Provider;
  model: string;
  prediction: boolean;
  fastTier: boolean;
  /** The role's reasoning, when the admin set one (otherwise the app's default for the role). */
  reasoning?: string;
}

const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface PipelineSettings {
  transcription: TranscriptionSettings;
  cleanup: ChatSettings;
  scribe: ChatSettings;
  fastPathMaxWords: number;
}

export interface OrgSettings {
  name: string;
  pipeline: PipelineSettings;
  leaderboardEnabled: boolean;
}

export const PROVIDERS: Provider[] = ["mistral", "openai"];

/** PCM sample rate each provider's streaming transcription expects. */
export const SAMPLE_RATES: Record<Provider, number> = { mistral: 16_000, openai: 24_000 };

/** Providers whose transcription this server can run (the chat relay works with all). */
export const SERVER_TRANSCRIPTION: Provider[] = ["mistral"];

export const DEFAULT_PIPELINE: PipelineSettings = {
  transcription: {
    provider: "mistral",
    mode: "hybrid",
    realtimeModel: "voxtral-mini-transcribe-realtime-3-0",
    batchModel: "voxtral-mini-transcribe-3-0",
    delayMs: 480,
    batchMaxAudioMs: 25_000,
  },
  cleanup: { provider: "mistral", model: "mistral-small-2603", prediction: true, fastTier: false },
  // Medium: first word in under 1.5 s and no invented facts in the Scribe bench (docs/latency.md).
  scribe: { provider: "mistral", model: "mistral-medium-2604", prediction: false, fastTier: false },
  fastPathMaxWords: 0,
};

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${label}: an object is required`);
  return value as Record<string, unknown>;
}

function provider(value: unknown, label: string): Provider {
  if (value === "mistral" || value === "openai") return value;
  throw new HttpError(400, `${label}: provider must be "mistral" or "openai"`);
}

function model(value: unknown, label: string): string {
  if (typeof value !== "string" || !MODEL.test(value)) throw new HttpError(400, `${label}: invalid model name`);
  return value;
}

function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${label}: a whole number from ${min} to ${max} is required`);
  }
  return value;
}

function chat(value: unknown, label: string): ChatSettings {
  const o = object(value, label);
  const settings: ChatSettings = {
    provider: provider(o.provider, label),
    model: model(o.model, label),
    prediction: o.prediction === true,
    fastTier: o.fastTier === true,
  };
  if (o.reasoning !== undefined && o.reasoning !== null) {
    if (typeof o.reasoning !== "string" || !REASONING_LEVELS.includes(o.reasoning)) {
      throw new HttpError(400, `${label}: reasoning must be one of ${REASONING_LEVELS.join(", ")}`);
    }
    settings.reasoning = o.reasoning;
  }
  return settings;
}

/** Validates a pipeline sent by the admin's app. */
export function parsePipeline(value: unknown): PipelineSettings {
  const o = object(value, "pipeline");
  const t = object(o.transcription, "transcription");
  const transcriptionProvider = provider(t.provider, "transcription");
  if (!SERVER_TRANSCRIPTION.includes(transcriptionProvider)) {
    throw new HttpError(400, `transcription: ${transcriptionProvider} isn't available through the server yet`);
  }
  const mode = t.mode;
  if (mode !== "realtime" && mode !== "batch" && mode !== "hybrid") {
    throw new HttpError(400, 'transcription: mode must be "realtime", "batch" or "hybrid"');
  }
  return {
    transcription: {
      provider: transcriptionProvider,
      mode,
      realtimeModel: model(t.realtimeModel, "transcription"),
      batchModel: model(t.batchModel, "transcription"),
      delayMs: integer(t.delayMs ?? 480, 80, 2400, "transcription.delayMs"),
      batchMaxAudioMs: integer(t.batchMaxAudioMs ?? 25_000, 0, 600_000, "transcription.batchMaxAudioMs"),
    },
    cleanup: chat(o.cleanup, "cleanup"),
    scribe: chat(o.scribe, "scribe"),
    fastPathMaxWords: integer(o.fastPathMaxWords ?? 0, 0, 50, "fastPathMaxWords"),
  };
}

interface Row {
  key: string;
  value: string;
}

export async function loadSettings(env: Env): Promise<OrgSettings> {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all<Row>();
  const values = new Map<string, unknown>();
  for (const row of results) {
    try {
      values.set(row.key, JSON.parse(row.value));
    } catch {
      // A broken value falls back to the default.
    }
  }
  const org = (values.get("org") ?? {}) as { name?: unknown };
  const team = (values.get("team") ?? {}) as { leaderboardEnabled?: unknown };
  let pipeline = DEFAULT_PIPELINE;
  try {
    if (values.has("pipeline")) pipeline = parsePipeline(values.get("pipeline"));
  } catch {
    pipeline = DEFAULT_PIPELINE;
  }
  return {
    name: typeof org.name === "string" && org.name.trim() ? org.name : env.ORG_NAME?.trim() || "diVoice",
    pipeline,
    leaderboardEnabled: team.leaderboardEnabled !== false,
  };
}

export async function put(env: Env, key: string, value: unknown, userId: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(key, JSON.stringify(value), Date.now(), userId)
    .run();
}

/** Applies the admin's changes: any of name, pipeline, leaderboardEnabled. */
export async function updateSettings(env: Env, userId: string | null, body: unknown): Promise<OrgSettings> {
  const o = object(body, "settings");
  if (o.name !== undefined) {
    if (typeof o.name !== "string" || !o.name.trim() || o.name.trim().length > 60) {
      throw new HttpError(400, "name: 1 to 60 characters");
    }
    await put(env, "org", { name: o.name.trim() }, userId);
  }
  if (o.pipeline !== undefined) await put(env, "pipeline", parsePipeline(o.pipeline), userId);
  if (o.leaderboardEnabled !== undefined) {
    if (typeof o.leaderboardEnabled !== "boolean") throw new HttpError(400, "leaderboardEnabled: true or false");
    await put(env, "team", { leaderboardEnabled: o.leaderboardEnabled }, userId);
  }
  return loadSettings(env);
}
