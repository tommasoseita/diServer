import type { User } from "./env";
import { HttpError } from "./errors";
import { addDays, isDay, redactSecrets } from "./util";

/**
 * Statistics without text: each dictation stores words, audio length, the member's local
 * day and typing speed. Same formulas as the app:
 * - time saved = typing the same words at the member's speed, minus the time spent speaking
 *   (per day, never negative);
 * - words per minute = words / minutes of speech;
 * - day streak = consecutive days with dictations, alive until the end of today.
 */

export interface StatsInput {
  sessionId: string;
  mode: "dictation" | "scribe";
  category: string | null;
  words: number;
  audioMs: number;
  localDay: string | null;
  typingWPM: number | null;
  transcriptionPath: string | null;
  cleanupPath: string | null;
  serverTimings: Record<string, number>;
  clientTimings: Record<string, number>;
  error: string | null;
}

const KEY = /^[a-zA-Z]{1,40}$/;

export function cleanTimings(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
    if (KEY.test(key) && typeof raw === "number" && Number.isFinite(raw)) out[key] = Math.round(raw);
  }
  return out;
}

export function label(value: unknown, max = 40): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.\-]{1,80}$/.test(value) ? value.slice(0, max) : null;
}

/** Stores one dictation's counts (insert or update: the server and the app both report). */
export async function recordStats(db: D1Database, userId: string, s: StatsInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dictation_events (id, user_id, created_at, mode, category, audio_ms, words, transcription_path, cleanup_path,
         server_timings, client_timings, error, local_day, typing_wpm)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       ON CONFLICT (id) DO UPDATE SET mode = excluded.mode, category = excluded.category, audio_ms = excluded.audio_ms,
         words = excluded.words, transcription_path = excluded.transcription_path, cleanup_path = excluded.cleanup_path,
         server_timings = excluded.server_timings, client_timings = excluded.client_timings, error = excluded.error,
         local_day = excluded.local_day, typing_wpm = excluded.typing_wpm
       WHERE dictation_events.user_id = excluded.user_id`,
    )
    .bind(
      s.sessionId,
      userId,
      Date.now(),
      s.mode,
      s.category,
      Math.max(0, Math.round(s.audioMs)),
      Math.max(0, Math.round(s.words)),
      s.transcriptionPath,
      s.cleanupPath,
      JSON.stringify(s.serverTimings),
      JSON.stringify(s.clientTimings),
      s.error ? redactSecrets(s.error).slice(0, 500) : null,
      s.localDay,
      s.typingWPM,
    )
    .run();
}

export interface Summary {
  words: number;
  dictations: number;
  savedSeconds: number;
  wordsPerMinute: number | null;
  streakDays: number;
}

export interface DayRow {
  user_id: string;
  local_day: string;
  words: number;
  audio_ms: number;
  dictations: number;
  typing_wpm: number | null;
}

export function savedSeconds(words: number, audioMs: number, typingWPM: number): number {
  if (typingWPM <= 0) return 0;
  return Math.max(0, (words / typingWPM) * 60 - audioMs / 1000);
}

/** Consecutive days with dictations ending today, or yesterday if nothing yet today. */
export function streak(days: Set<string>, today: string): number {
  let day = days.has(today) ? today : addDays(today, -1);
  let count = 0;
  while (days.has(day)) {
    count++;
    day = addDays(day, -1);
  }
  return count;
}

export function summarize(rows: DayRow[], allDays: Set<string>, today: string): Summary {
  let words = 0;
  let audioMs = 0;
  let dictations = 0;
  let saved = 0;
  for (const row of rows) {
    words += row.words;
    audioMs += row.audio_ms;
    dictations += row.dictations;
    saved += savedSeconds(row.words, row.audio_ms, row.typing_wpm ?? 40);
  }
  return {
    words,
    dictations,
    savedSeconds: Math.round(saved),
    wordsPerMinute: audioMs > 0 ? words / (audioMs / 60_000) : null,
    streakDays: streak(allDays, today),
  };
}

export interface Period {
  today: string;
  /** Number of days including today; null for all time. */
  days: number | null;
}

export function parsePeriod(query: { today?: string; days?: string }): Period {
  const today = query.today;
  if (!isDay(today)) throw new HttpError(400, "today: a day as YYYY-MM-DD is required");
  if (query.days === undefined || query.days === "all") return { today, days: null };
  const days = Number(query.days);
  if (!Number.isInteger(days) || days < 1 || days > 3660) throw new HttpError(400, "days: 1 to 3660, or all");
  return { today, days };
}

async function dayRows(db: D1Database, userIds: string[] | null): Promise<DayRow[]> {
  const filter = userIds ? `AND user_id IN (${userIds.map((_, i) => `?${i + 1}`).join(", ")})` : "";
  const { results } = await db
    .prepare(
      `SELECT user_id, local_day, sum(words) AS words, sum(audio_ms) AS audio_ms, count(*) AS dictations,
         CAST(round(avg(typing_wpm)) AS INTEGER) AS typing_wpm
       FROM dictation_events
       WHERE mode = 'dictation' AND local_day IS NOT NULL AND words > 0 ${filter}
       GROUP BY user_id, local_day`,
    )
    .bind(...(userIds ?? []))
    .all<DayRow>();
  return results;
}

function inPeriod(row: DayRow, period: Period): boolean {
  if (row.local_day > period.today) return false;
  return period.days === null || row.local_day >= addDays(period.today, -(period.days - 1));
}

export async function myStats(db: D1Database, user: User, period: Period): Promise<{ summary: Summary; recent: { day: string; words: number }[] }> {
  const rows = await dayRows(db, [user.id]);
  const allDays = new Set(rows.map((r) => r.local_day));
  const recent = Array.from({ length: 14 }, (_, i) => {
    const day = addDays(period.today, i - 13);
    return { day, words: rows.find((r) => r.local_day === day)?.words ?? 0 };
  });
  return { summary: summarize(rows.filter((r) => inPeriod(r, period)), allDays, period.today), recent };
}

export interface TeamRow extends Summary {
  id: string;
  name: string;
  isMe: boolean;
}

/** The leaderboard: members who don't hide from the team, most words first. */
export async function teamStats(db: D1Database, viewer: User, period: Period): Promise<TeamRow[]> {
  const { results: members } = await db
    .prepare("SELECT id, name FROM users WHERE revoked_at IS NULL AND hide_from_team = 0")
    .all<{ id: string; name: string }>();
  if (members.length === 0) return [];
  const rows = await dayRows(db, null);
  const visible = new Set(members.map((m) => m.id));
  const byUser = new Map<string, DayRow[]>();
  for (const row of rows) {
    if (!visible.has(row.user_id)) continue;
    byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row]);
  }
  return members
    .map((m) => {
      const own = byUser.get(m.id) ?? [];
      const summary = summarize(own.filter((r) => inPeriod(r, period)), new Set(own.map((r) => r.local_day)), period.today);
      return { id: m.id, name: m.name, isMe: m.id === viewer.id, ...summary };
    })
    .sort((a, b) => b.words - a.words || a.name.localeCompare(b.name));
}
