import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { clearAuthCache } from "../src/auth";
import type { Env } from "../src/env";
import { clearKeyCache, decryptKey, encryptKey, providerKey } from "../src/keys";
import { DEFAULT_PIPELINE } from "../src/settings";
import { call, createUser, resetOrg } from "./helpers";

beforeEach(async () => {
  clearAuthCache();
  clearKeyCache();
  await resetOrg();
});

describe("authentication", () => {
  it("needs a valid, unrevoked token", async () => {
    expect((await call("/v2/me")).status).toBe(401);
    expect((await call("/v2/me", { token: "dv_not_a_real_token_123456" })).status).toBe(401);
    const { user, token } = await createUser();
    const ok = await call("/v2/me", { token });
    expect(ok.status).toBe(200);
    const me = (await ok.json()) as Record<string, any>;
    expect(me.member).toMatchObject({ id: user.id, role: "member", hideFromTeam: false });
    expect(me.org.server).toBe("https://team.example.com");
    expect(me.pipeline).toEqual(DEFAULT_PIPELINE);
    expect(me.sampleRate).toBe(16_000);

    await env.DB.prepare("UPDATE users SET revoked_at = 1 WHERE id = ?1").bind(user.id).run();
    clearAuthCache();
    expect((await call("/v2/me", { token })).status).toBe(401);
  });

  it("keeps admin endpoints to admins", async () => {
    const { token } = await createUser("member");
    expect((await call("/v2/admin/settings", { token })).status).toBe(403);
    expect((await call("/v2/admin/invites", { token, method: "POST", json: { kind: "team" } })).status).toBe(403);
    expect((await call("/v2/dictionary", { token, method: "POST", json: { term: "Zentrix" } })).status).toBe(403);
  });

  it("public pages need no token", async () => {
    expect((await call("/health")).status).toBe(200);
    expect((await call("/v2/setup")).status).toBe(200);
    expect((await call("/v2/relay")).status).toBe(401);
  });
});

describe("settings", () => {
  it("lets the admin set the name, models and leaderboard", async () => {
    const { token } = await createUser("admin");
    const pipeline = structuredClone(DEFAULT_PIPELINE);
    pipeline.cleanup.model = "mistral-medium-2604";
    pipeline.scribe = { provider: "openai", model: "gpt-6.1-sol", prediction: false, fastTier: true, reasoning: "low" };
    const response = await call("/v2/admin/settings", { token, method: "PATCH", json: { name: "Acme", pipeline, leaderboardEnabled: false } });
    expect(response.status).toBe(200);
    const settings = (await response.json()) as Record<string, any>;
    expect(settings).toMatchObject({ name: "Acme", leaderboardEnabled: false });
    expect(settings.pipeline.scribe.provider).toBe("openai");
    expect(settings.pipeline.scribe.reasoning).toBe("low");
    const badReasoning = structuredClone(DEFAULT_PIPELINE) as any;
    badReasoning.scribe.reasoning = "lots";
    expect((await call("/v2/admin/settings", { token, method: "PATCH", json: { pipeline: badReasoning } })).status).toBe(400);
    expect(settings.keys).toEqual([
      { provider: "mistral", source: null, updatedAt: null },
      { provider: "openai", source: null, updatedAt: null },
      { provider: "elevenlabs", source: null, updatedAt: null },
    ]);

    const { token: member } = await createUser("member");
    const me = (await (await call("/v2/me", { token: member })).json()) as Record<string, any>;
    expect(me.org.name).toBe("Acme");
    expect(me.pipeline.cleanup.model).toBe("mistral-medium-2604");
    expect(me.leaderboardEnabled).toBe(false);
  });

  it("rejects invalid models and transcription the server can't run", async () => {
    const { token } = await createUser("admin");
    const bad = structuredClone(DEFAULT_PIPELINE) as any;
    bad.cleanup.model = "a model with spaces";
    expect((await call("/v2/admin/settings", { token, method: "PATCH", json: { pipeline: bad } })).status).toBe(400);
    const openaiTranscription = structuredClone(DEFAULT_PIPELINE) as any;
    openaiTranscription.transcription.provider = "openai";
    const response = await call("/v2/admin/settings", { token, method: "PATCH", json: { pipeline: openaiTranscription } });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("isn't available through the server yet");
    expect((await call("/v2/admin/settings", { token, method: "PATCH", json: { name: "" } })).status).toBe(400);
  });
});

describe("ElevenLabs", () => {
  it("transcribes when the admin chooses it, with its own key, listed with the others", async () => {
    const { token } = await createUser("admin");
    const pipeline = structuredClone(DEFAULT_PIPELINE) as any;
    pipeline.transcription = { ...pipeline.transcription, provider: "elevenlabs", realtimeModel: "scribe_v2_realtime", batchModel: "scribe_v2" };
    const saved = await call("/v2/admin/settings", { token, method: "PATCH", json: { pipeline } });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as Record<string, any>).pipeline.transcription).toMatchObject({ provider: "elevenlabs", batchModel: "scribe_v2" });

    const { token: member } = await createUser("member");
    const me = (await (await call("/v2/me", { token: member })).json()) as Record<string, any>;
    expect(me.sampleRate).toBe(16_000);

    // A chat provider it isn't.
    const chat = structuredClone(DEFAULT_PIPELINE) as any;
    chat.cleanup.provider = "elevenlabs";
    expect((await call("/v2/admin/settings", { token, method: "PATCH", json: { pipeline: chat } })).status).toBe(400);

    const key = "sk_0123456789abcdef0123456789abcdef0123456789abcdef";
    const put = await call("/v2/admin/keys/elevenlabs", { token, method: "PUT", json: { key } });
    expect(put.status).toBe(200);
    const text = await put.text();
    expect(text).not.toContain(key);
    expect(JSON.parse(text).keys).toContainEqual(expect.objectContaining({ provider: "elevenlabs", source: "admin" }));
    // In `secrets` (provider_keys only accepts Mistral and OpenAI), encrypted.
    const row = await env.DB.prepare("SELECT ciphertext FROM secrets WHERE name = 'provider_key.elevenlabs'").first<{ ciphertext: string }>();
    expect(row!.ciphertext).not.toContain("sk_0123");
    clearKeyCache();
    expect(await providerKey(env as unknown as Env, "elevenlabs")).toBe(key);

    expect((await call("/v2/admin/keys/elevenlabs", { token, method: "DELETE" })).status).toBe(200);
    clearKeyCache();
    expect(await providerKey(env as unknown as Env, "elevenlabs")).toBeUndefined();
    clearKeyCache();
    expect(await providerKey({ ...(env as unknown as Env), ELEVENLABS_API_KEY: "sk_from_the_worker_secret_0123456789" }, "elevenlabs")).toBe(
      "sk_from_the_worker_secret_0123456789",
    );
  });
});

describe("provider keys", () => {
  it("are stored encrypted and never returned", async () => {
    const { token } = await createUser("admin");
    const key = "mk_test_0123456789abcdefghijklmnop";
    const saved = await call("/v2/admin/keys/mistral", { token, method: "PUT", json: { key } });
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain(key);
    expect(JSON.parse(text).keys[0]).toMatchObject({ provider: "mistral", source: "admin" });

    const row = await env.DB.prepare("SELECT ciphertext FROM provider_keys WHERE provider = 'mistral'").first<{ ciphertext: string }>();
    expect(row!.ciphertext).not.toContain("mk_test");
    expect(await providerKey(env as unknown as Env, "mistral")).toBe(key);

    const settings = await (await call("/v2/admin/settings", { token })).text();
    expect(settings).not.toContain(key);

    expect((await call("/v2/admin/keys/mistral", { token, method: "PUT", json: { key: "short" } })).status).toBe(400);
    expect((await call("/v2/admin/keys/anthropic", { token, method: "PUT", json: { key } })).status).toBe(404);
    await call("/v2/admin/keys/mistral", { token, method: "DELETE" });
    expect(await providerKey(env as unknown as Env, "mistral")).toBeUndefined();
  });

  it("are cached for a minute, and refreshed when saved", async () => {
    const { user } = await createUser("admin");
    const typed = env as unknown as Env;
    const { saveProviderKey } = await import("../src/keys");
    await saveProviderKey(typed, "mistral", "first-key-0123456789abcdef", user.id);
    expect(await providerKey(typed, "mistral")).toBe("first-key-0123456789abcdef");
    // Changed behind this isolate's back: still the cached value...
    await env.DB.prepare("DELETE FROM provider_keys").run();
    expect(await providerKey(typed, "mistral")).toBe("first-key-0123456789abcdef");
    // ...until the minute is over.
    expect(await providerKey(typed, "mistral", Date.now() + 61_000)).toBeUndefined();
    await saveProviderKey(typed, "mistral", "second-key-0123456789abcdef", user.id);
    expect(await providerKey(typed, "mistral")).toBe("second-key-0123456789abcdef");
  });

  it("fall back to the Worker secret", async () => {
    clearKeyCache();
    const withSecret = { ...(env as unknown as Env), MISTRAL_API_KEY: "secret-from-wrangler" };
    expect(await providerKey(withSecret, "mistral")).toBe("secret-from-wrangler");
    expect(await providerKey(withSecret, "openai")).toBeUndefined();
  });

  it("can't be decrypted with another secret or as another provider", async () => {
    const secret = "a".repeat(40);
    const { ciphertext, iv } = await encryptKey(secret, "mistral", "the-key-value-0123456789");
    expect(await decryptKey(secret, "mistral", ciphertext, iv)).toBe("the-key-value-0123456789");
    await expect(decryptKey("b".repeat(40), "mistral", ciphertext, iv)).rejects.toThrow();
    await expect(decryptKey(secret, "openai", ciphertext, iv)).rejects.toThrow();
  });

  it("need SERVER_SECRET (or DIVOICE_SECRET) to be saved", async () => {
    const { user } = await createUser("admin");
    const { saveProviderKey } = await import("../src/keys");
    await expect(saveProviderKey({ ...(env as unknown as Env), DIVOICE_SECRET: undefined }, "mistral", "x".repeat(30), user.id)).rejects.toThrow(
      "SERVER_SECRET",
    );
  });
});

describe("members", () => {
  it("lists, promotes and removes members, keeping at least one admin", async () => {
    const { user: admin, token } = await createUser("admin", "Ada Admin");
    const { user: bob, token: bobToken } = await createUser("member", "Bob");
    const list = (await (await call("/v2/admin/members", { token })).json()) as { members: { id: string; role: string }[] };
    expect(list.members.map((m) => m.id)).toEqual([admin.id, bob.id]);

    expect((await call(`/v2/admin/members/${admin.id}`, { token, method: "PATCH", json: { role: "member" } })).status).toBe(409);
    expect((await call(`/v2/admin/members/${bob.id}`, { token, method: "PATCH", json: { role: "admin" } })).status).toBe(200);
    expect((await call(`/v2/admin/members/${bob.id}`, { token, method: "PATCH", json: { role: "owner" } })).status).toBe(400);

    expect((await call(`/v2/admin/members/${bob.id}`, { token, method: "DELETE" })).status).toBe(204);
    clearAuthCache();
    expect((await call("/v2/me", { token: bobToken })).status).toBe(401);
    expect((await call(`/v2/admin/members/${admin.id}`, { token, method: "DELETE" })).status).toBe(409);
  });

  it("lets a member hide from the team", async () => {
    const { token } = await createUser();
    expect((await call("/v2/me", { token, method: "PATCH", json: { hideFromTeam: true } })).status).toBe(204);
    const me = (await (await call("/v2/me", { token })).json()) as { member: { hideFromTeam: boolean } };
    expect(me.member.hideFromTeam).toBe(true);
    expect((await call("/v2/me", { token, method: "PATCH", json: { hideFromTeam: "yes" } })).status).toBe(400);
  });
});

describe("team dictionary", () => {
  it("is readable by members and editable by admins", async () => {
    const { token: admin } = await createUser("admin");
    const { token: member } = await createUser("member");
    const created = await call("/v2/dictionary", { token: admin, method: "POST", json: { term: " Zentrix ", aliases: ["Centrix", "zentrix"], note: "product" } });
    expect(created.status).toBe(201);
    const { entry } = (await created.json()) as { entry: Record<string, unknown> };
    expect(entry).toMatchObject({ term: "Zentrix", aliases: ["centrix"], note: "product", scope: "team", source: "manual", enabled: true, usageCount: 0 });
    expect((await call("/v2/dictionary", { token: admin, method: "POST", json: { term: "zentrix" } })).status).toBe(409);

    const list = (await (await call("/v2/dictionary", { token: member })).json()) as { team: { term: string }[] };
    expect(list.team.map((e) => e.term)).toEqual(["Zentrix"]);

    const updated = await call(`/v2/dictionary/${entry.id}`, { token: admin, method: "PATCH", json: { enabled: false } });
    expect(((await updated.json()) as { entry: { enabled: boolean } }).entry.enabled).toBe(false);
    expect((await call(`/v2/dictionary/${entry.id}`, { token: admin, method: "DELETE" })).status).toBe(204);
  });
});

describe("setup", () => {
  it("creates the first admin once, with the server secret", async () => {
    const secret = (env as unknown as Env).DIVOICE_SECRET!;
    expect(((await (await call("/v2/setup")).json()) as { claimed: boolean }).claimed).toBe(false);
    const json = { secret, name: "Ada Lovelace", email: "ada@example.com", orgName: "Acme" };
    expect((await call("/v2/setup/claim", { method: "POST", json: { ...json, secret: "wrong" } })).status).toBe(403);
    const claimed = await call("/v2/setup/claim", { method: "POST", json });
    expect(claimed.status).toBe(201);
    const body = (await claimed.json()) as { token: string; member: { role: string }; org: { name: string } };
    expect(body.member.role).toBe("admin");
    expect(body.org.name).toBe("Acme");
    expect((await call("/v2/admin/settings", { token: body.token })).status).toBe(200);
    expect((await call("/v2/setup/claim", { method: "POST", json })).status).toBe(409);
  });
});
