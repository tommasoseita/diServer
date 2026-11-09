import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { authenticate, newToken } from "./auth";
import { createTeamEntry, deleteTeamEntry, teamEntries, updateTeamEntry } from "./dictionary";
import type { Env, User } from "./env";
import { HttpError } from "./errors";
import { createInvite, join, listInvites, normalizeEmail, normalizeName, revokeInvite, usableInvite, type Invite } from "./invites";
import { keyStatus, removeProviderKey, saveProviderKey, serverSecret } from "./keys";
import { hasAdmin, hideFromTeam, listMembers, removeMember, setHideFromTeam, setRole } from "./members";
import { adminMail, joinMail, loadMail, mailConfig, publicOrg, removeAiKey, replaceAiKey, replaceGoogleClient, setupMail, updateAdminMail } from "./mail";
import { appDownload, inviteDownload, inviteFileName, invitePage, orgPage, serveUpdate } from "./pages";
import { batchTranscribe, openRealtime } from "./providers/mistral";
import { acceptRelay, relayDeps } from "./relay";
import { loadSettings, SAMPLE_RATES, updateSettings, type Provider } from "./settings";
import { myStats, parsePeriod, recordStats, teamStats } from "./stats";
import { safeEqual } from "./util";

export type { Env } from "./env";

type AppEnv = { Bindings: Env; Variables: { user: User } };

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

function origin(c: Context<AppEnv>): string {
  return new URL(c.req.url).origin;
}

function inviteJSON(c: Context<AppEnv>, invite: Invite) {
  return { ...invite, url: `${origin(c)}/i/${invite.code}` };
}

function provider(value: string): Provider {
  if (value === "mistral" || value === "openai") return value;
  throw new HttpError(404, "unknown provider");
}

// Best-effort limit per isolate: a stuck or looping app can't flood the providers.
const relayStarts = new Map<string, number[]>();
function allowRelay(userId: string, now = Date.now()): boolean {
  const recent = (relayStarts.get(userId) ?? []).filter((t) => now - t < 300_000);
  if (recent.length >= 60) return false;
  recent.push(now);
  relayStarts.set(userId, recent);
  return true;
}

// MARK: Public

app.get("/health", (c) => c.json({ ok: true }));

app.get("/i/:code", async (c) => {
  const settings = await loadSettings(c.env);
  return invitePage(c.env, settings.name, c.req.param("code"), origin(c), c.req.header("Accept-Language") ?? null);
});

app.get("/i/:code/download", async (c) => {
  const settings = await loadSettings(c.env);
  return inviteDownload(c.env, c.req.param("code"), { orgName: settings.name, host: new URL(c.req.url).host });
});

app.get("/updates/:file", (c) => serveUpdate(c.env, c.req.param("file")));

// MARK: diMail (public)

/** The organization's permanent diMail link. */
app.get("/dimail", async (c) => {
  const [settings, mail] = await Promise.all([loadSettings(c.env), loadMail(c.env)]);
  const configured = !!mail.googleClientId;
  return orgPage(settings.name, origin(c), c.req.header("Accept-Language") ?? null, { configured, domain: mail.domain, autoJoin: mail.autoJoin });
});

app.get("/dimail/download", async (c) => {
  const settings = await loadSettings(c.env);
  return appDownload(c.env, "dimail", inviteFileName(settings.name, new URL(c.req.url).host, "", "dimail"));
});

/** Before signing in from the organization link: the organization and its Google client. */
app.get("/v2/mail/org", async (c) => c.json(await publicOrg(c.env, origin(c))));

/** Before signing in with an invite: who invites, and the Google client to sign in with. */
app.get("/v2/mail/invites/:code", async (c) => {
  const invite = await usableInvite(c.env.DB, c.req.param("code"));
  const { org, google } = await publicOrg(c.env, origin(c));
  const inviter = invite.createdBy
    ? await c.env.DB.prepare("SELECT name FROM users WHERE id = ?1").bind(invite.createdBy).first<{ name: string }>()
    : null;
  return c.json({ org, google, inviter: inviter?.name ?? null, kind: invite.kind, email: invite.email, expiresAt: invite.expiresAt });
});

/** "Sign in with Google": `{idToken, code?}` → `{token, member, org}`. */
app.post("/v2/mail/join", async (c) => c.json(await joinMail(c.env, await jsonBody(c), origin(c)), 201));

/** The admin sets diMail up, proving with the server secret that they own the server. */
app.post("/v2/mail/setup", async (c) => {
  const result = await setupMail(c.env, await jsonBody(c), origin(c), (secret) => {
    const expected = serverSecret(c.env);
    if (expected.length < 32) throw new HttpError(503, "set SERVER_SECRET on the server first");
    if (typeof secret !== "string" || !safeEqual(secret.trim(), expected)) throw new HttpError(403, "wrong server secret");
  });
  return c.json(result, 201);
});

/** What the app shows before joining. */
app.get("/v2/invites/:code", async (c) => {
  const invite = await usableInvite(c.env.DB, c.req.param("code"));
  const settings = await loadSettings(c.env);
  const inviter = invite.createdBy
    ? await c.env.DB.prepare("SELECT name FROM users WHERE id = ?1").bind(invite.createdBy).first<{ name: string }>()
    : null;
  return c.json({
    org: { name: settings.name, server: origin(c) },
    inviter: inviter?.name ?? null,
    kind: invite.kind,
    name: invite.name,
    email: invite.email,
    needsEmail: invite.kind === "team",
    expiresAt: invite.expiresAt,
  });
});

app.post("/v2/join", async (c) => {
  const body = (await jsonBody(c)) as Record<string, unknown>;
  if (typeof body.code !== "string") throw new HttpError(400, "code: required");
  const result = await join(c.env.DB, body.code, body);
  const settings = await loadSettings(c.env);
  return c.json({ token: result.token, member: result.member, org: { name: settings.name, server: origin(c) } }, 201);
});

app.get("/v2/setup", async (c) => c.json({ claimed: await hasAdmin(c.env.DB), secretConfigured: serverSecret(c.env).length >= 32 }));

/** The first admin of a new deployment proves they set SERVER_SECRET. Works once. */
app.post("/v2/setup/claim", async (c) => {
  const body = (await jsonBody(c)) as Record<string, unknown>;
  const secret = serverSecret(c.env);
  if (secret.length < 32) throw new HttpError(503, "set SERVER_SECRET on the server first");
  if (typeof body.secret !== "string" || !safeEqual(body.secret.trim(), secret)) throw new HttpError(403, "wrong setup secret");
  if (await hasAdmin(c.env.DB)) throw new HttpError(409, "this server already has an admin");
  const name = normalizeName(body.name);
  const email = normalizeEmail(body.email);
  const { token, hash } = await newToken();
  const member: User = { id: crypto.randomUUID(), name, email, role: "admin" };
  await c.env.DB.prepare("INSERT INTO users (id, name, email, role, token_hash, created_at) VALUES (?1, ?2, ?3, 'admin', ?4, ?5)")
    .bind(member.id, name, email, hash, Date.now())
    .run();
  const settings = body.orgName !== undefined ? await updateSettings(c.env, member.id, { name: body.orgName }) : await loadSettings(c.env);
  return c.json({ token, member, org: { name: settings.name, server: origin(c) } }, 201);
});

// MARK: Members

const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const user = await authenticate(c.env.DB, c.req.header("Authorization"), (work) => c.executionCtx.waitUntil(work.catch(() => undefined)));
  if (!user) throw new HttpError(401, "missing or invalid token");
  c.set("user", user);
  await next();
});

const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user").role !== "admin") throw new HttpError(403, "only admins can do this");
  await next();
});

app.use("/v2/me", requireUser);
app.use("/v2/mail/config", requireUser);
app.use("/v2/dictionary", requireUser);
app.use("/v2/dictionary/*", requireUser);
app.use("/v2/relay", requireUser);
app.use("/v2/stats/*", requireUser);
app.use("/v2/admin/*", requireUser, requireAdmin);

app.get("/v2/me", async (c) => {
  const user = c.get("user");
  const settings = await loadSettings(c.env);
  return c.json({
    member: { ...user, hideFromTeam: await hideFromTeam(c.env.DB, user.id) },
    org: { name: settings.name, server: origin(c) },
    pipeline: settings.pipeline,
    sampleRate: SAMPLE_RATES[settings.pipeline.transcription.provider],
    leaderboardEnabled: settings.leaderboardEnabled,
  });
});

app.patch("/v2/me", async (c) => {
  const body = (await jsonBody(c)) as Record<string, unknown>;
  if (body.hideFromTeam !== undefined) await setHideFromTeam(c.env.DB, c.get("user").id, body.hideFromTeam);
  return c.body(null, 204);
});

/** diMail's configuration for a member: Google client, AI provider, model and key, domains. */
app.get("/v2/mail/config", async (c) => c.json(await mailConfig(c.env, c.get("user"), origin(c))));

app.get("/v2/dictionary", async (c) => c.json({ team: await teamEntries(c.env.DB) }));

app.post("/v2/dictionary", requireAdmin, async (c) => c.json({ entry: await createTeamEntry(c.env.DB, c.get("user"), await jsonBody(c)) }, 201));
app.patch("/v2/dictionary/:id", requireAdmin, async (c) => c.json({ entry: await updateTeamEntry(c.env.DB, c.req.param("id"), await jsonBody(c)) }));
app.delete("/v2/dictionary/:id", requireAdmin, async (c) => {
  await deleteTeamEntry(c.env.DB, c.req.param("id"));
  return c.body(null, 204);
});

app.get("/v2/relay", (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "a WebSocket connection is required");
  const user = c.get("user");
  if (!allowRelay(user.id)) throw new HttpError(429, "too many dictations in a few minutes: try again shortly");
  const env = c.env;
  const ctx = c.executionCtx;
  return acceptRelay(
    user,
    relayDeps(env, {
      settings: () => loadSettings(env),
      openRealtime,
      batchTranscribe,
      record: (stats) => ctx.waitUntil(recordStats(env.DB, user.id, stats).catch((err) => console.error("recordStats", err))),
      warm: (baseUrl) =>
        ctx.waitUntil(
          fetch(`${baseUrl}/v1/models`, { method: "HEAD", signal: AbortSignal.timeout(5_000) })
            .then((response) => response.body?.cancel())
            .catch(() => undefined),
        ),
    }),
  );
});

app.get("/v2/stats/me", async (c) => {
  const period = parsePeriod({ today: c.req.query("today"), days: c.req.query("days") });
  return c.json(await myStats(c.env.DB, c.get("user"), period));
});

/** The leaderboard; empty when the admin turned it off. */
app.get("/v2/stats/team", async (c) => {
  const period = parsePeriod({ today: c.req.query("today"), days: c.req.query("days") });
  const settings = await loadSettings(c.env);
  if (!settings.leaderboardEnabled) return c.json({ leaderboardEnabled: false, members: [] });
  return c.json({ leaderboardEnabled: true, members: await teamStats(c.env.DB, c.get("user"), period) });
});

// MARK: Admin

app.get("/v2/admin/settings", async (c) => {
  const settings = await loadSettings(c.env);
  return c.json({ ...settings, keys: await keyStatus(c.env) });
});

app.patch("/v2/admin/settings", async (c) => {
  const settings = await updateSettings(c.env, c.get("user").id, await jsonBody(c));
  return c.json({ ...settings, keys: await keyStatus(c.env) });
});

app.put("/v2/admin/keys/:provider", async (c) => {
  const body = (await jsonBody(c)) as Record<string, unknown>;
  await saveProviderKey(c.env, provider(c.req.param("provider")), body.key, c.get("user").id);
  return c.json({ keys: await keyStatus(c.env) });
});

app.delete("/v2/admin/keys/:provider", async (c) => {
  await removeProviderKey(c.env, provider(c.req.param("provider")));
  return c.json({ keys: await keyStatus(c.env) });
});

app.get("/v2/admin/mail", async (c) => c.json(await adminMail(c.env)));
app.patch("/v2/admin/mail", async (c) => c.json(await updateAdminMail(c.env, c.get("user"), await jsonBody(c))));
app.put("/v2/admin/mail/google", async (c) => c.json(await replaceGoogleClient(c.env, c.get("user"), await jsonBody(c))));
app.put("/v2/admin/mail/ai-key", async (c) => c.json(await replaceAiKey(c.env, c.get("user"), await jsonBody(c))));
app.delete("/v2/admin/mail/ai-key", async (c) => c.json(await removeAiKey(c.env)));

app.get("/v2/admin/members", async (c) => c.json({ members: await listMembers(c.env.DB) }));

app.patch("/v2/admin/members/:id", async (c) => {
  const body = (await jsonBody(c)) as Record<string, unknown>;
  return c.json({ member: await setRole(c.env.DB, c.req.param("id"), body.role) });
});

app.delete("/v2/admin/members/:id", async (c) => {
  await removeMember(c.env.DB, c.get("user"), c.req.param("id"));
  return c.body(null, 204);
});

app.get("/v2/admin/invites", async (c) => c.json({ invites: (await listInvites(c.env.DB)).map((i) => inviteJSON(c, i)) }));

app.post("/v2/admin/invites", async (c) => c.json({ invite: inviteJSON(c, await createInvite(c.env.DB, c.get("user"), await jsonBody(c))) }, 201));

app.delete("/v2/admin/invites/:code", async (c) => {
  await revokeInvite(c.env.DB, c.req.param("code"));
  return c.body(null, 204);
});

export default app;
