import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { clearAuthCache } from "../src/auth";
import { recordStats, savedSeconds, streak, type StatsInput } from "../src/stats";
import { call, createUser, resetOrg } from "./helpers";

beforeEach(async () => {
  clearAuthCache();
  await resetOrg();
});

function event(day: string, words: number, audioMs: number, extra: Partial<StatsInput> = {}): StatsInput {
  return {
    sessionId: crypto.randomUUID(),
    mode: "dictation",
    category: null,
    words,
    audioMs,
    localDay: day,
    typingWPM: 40,
    transcriptionPath: "batch",
    cleanupPath: "llm",
    serverTimings: {},
    clientTimings: {},
    error: null,
    ...extra,
  };
}

describe("formulas", () => {
  it("match the app's", () => {
    expect(savedSeconds(120, 60_000, 40)).toBe(120);
    expect(savedSeconds(5, 60_000, 40)).toBe(0);
    expect(streak(new Set(["2026-11-08", "2026-11-07", "2026-11-06"]), "2026-11-09")).toBe(3);
    expect(streak(new Set(["2026-11-08"]), "2026-11-10")).toBe(0);
    expect(streak(new Set(["2027-01-01", "2026-12-31", "2026-12-30"]), "2027-01-01")).toBe(3);
  });
});

describe("my statistics", () => {
  it("sum the period, Scribe included, keep the streak and list the last 14 days", async () => {
    const { user, token } = await createUser();
    await recordStats(env.DB, user.id, event("2026-11-08", 120, 60_000));
    await recordStats(env.DB, user.id, event("2026-11-07", 80, 30_000));
    await recordStats(env.DB, user.id, event("2026-11-01", 400, 120_000));
    await recordStats(env.DB, user.id, event("2026-11-08", 50, 10_000, { mode: "scribe" }));

    // 11-08: 170 words (Scribe too) in 70 s, 255 s to type at 40 wpm: 185 s saved; 11-07: 90 s.
    const week = (await (await call("/v2/stats/me?today=2026-11-09&days=7", { token })).json()) as Record<string, any>;
    expect(week.summary).toMatchObject({ words: 250, dictations: 3, savedSeconds: 275, streakDays: 2 });
    expect(week.summary.wordsPerMinute).toBeCloseTo(250 / (100 / 60));
    expect(week.recent).toHaveLength(14);
    expect(week.recent.at(-2)).toEqual({ day: "2026-11-08", words: 170 });

    const all = (await (await call("/v2/stats/me?today=2026-11-09&days=all", { token })).json()) as Record<string, any>;
    expect(all.summary.words).toBe(650);
    expect((await call("/v2/stats/me?days=7", { token })).status).toBe(400);
  });
});

describe("dictations without a local day", () => {
  it("count on their UTC day, so past ones come back too", async () => {
    const { user, token } = await createUser();
    await recordStats(env.DB, user.id, event("2026-11-08", 30, 10_000, { localDay: null }));
    const utcToday = new Date().toISOString().slice(0, 10);
    const stats = (await (await call(`/v2/stats/me?today=${utcToday}&days=1`, { token })).json()) as Record<string, any>;
    expect(stats.summary).toMatchObject({ words: 30, dictations: 1 });
    expect(stats.recent.at(-1)).toEqual({ day: utcToday, words: 30 });
  });
});

describe("leaderboard", () => {
  it("ranks visible members by words, and disappears when the admin turns it off", async () => {
    const { user: ada, token: admin } = await createUser("admin", "Ada");
    const { user: bob, token: bobToken } = await createUser("member", "Bob");
    const { user: eve, token: eveToken } = await createUser("member", "Eve");
    await recordStats(env.DB, ada.id, event("2026-11-09", 100, 60_000));
    await recordStats(env.DB, bob.id, event("2026-11-09", 300, 60_000));
    await recordStats(env.DB, eve.id, event("2026-11-09", 500, 60_000));
    await call("/v2/me", { token: eveToken, method: "PATCH", json: { hideFromTeam: true } });

    const team = (await (await call("/v2/stats/team?today=2026-11-09&days=7", { token: bobToken })).json()) as Record<string, any>;
    expect(team.leaderboardEnabled).toBe(true);
    expect(team.members.map((m: { name: string; words: number; isMe: boolean }) => [m.name, m.words, m.isMe])).toEqual([
      ["Bob", 300, true],
      ["Ada", 100, false],
    ]);
    expect(JSON.stringify(team)).not.toContain("Eve");

    // Eve still sees her own statistics.
    const mine = (await (await call("/v2/stats/me?today=2026-11-09&days=7", { token: eveToken })).json()) as Record<string, any>;
    expect(mine.summary.words).toBe(500);

    await call("/v2/admin/settings", { token: admin, method: "PATCH", json: { leaderboardEnabled: false } });
    for (const token of [admin, bobToken]) {
      expect(await (await call("/v2/stats/team?today=2026-11-09&days=7", { token })).json()).toEqual({ leaderboardEnabled: false, members: [] });
    }
  });
});
