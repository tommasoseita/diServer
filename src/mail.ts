import { newMemberToken } from "./auth";
import type { Env, Role, User } from "./env";
import { HttpError } from "./errors";
import { verifyIdToken, type GoogleIdentity } from "./google";
import { normalizeName, usableInvite, type Invite } from "./invites";
import { decryptKey, encryptKey, KEY, secretOf } from "./keys";
import { loadSettings, put, type Provider } from "./settings";
import { sha256Hex } from "./util";

/**
 * diMail on the organization server. The server hands out configuration and keeps the member
 * list; mail never passes through it: each Mac talks to Gmail and to the AI provider directly.
 *
 * - The organization's Google OAuth client ("Desktop app"): its id, and its secret encrypted. Google
 *   doesn't treat a desktop client's secret as confidential (PKCE protects the sign-in), so the
 *   server gives it to anyone about to sign in: invite holders and the organization page.
 * - diMail's AI key, encrypted, given to members (decided on 9 November 2026: the alternative, a
 *   relay, would put mail on the server). Separate from diVoice's keys, which never leave.
 * - Members sign in with Google: the server verifies the ID token, so their address is certain.
 */

export const MAIL_PROVIDERS: Provider[] = ["mistral", "openai"];
export const DEFAULT_MAIL_AI = { provider: "mistral" as Provider, model: "mistral-small-2603" };

const GOOGLE_SECRET = "mail.google_client_secret";
const AI_KEY = "mail.ai_key";
const CLIENT_ID = /^[0-9]{3,30}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/;
const CLIENT_SECRET = /^[A-Za-z0-9_\-]{8,100}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface MailSettings {
  /** The organization's email domain, e.g. "acme.example". */
  domain: string | null;
  /** Anyone with a verified address of the domain joins without an invite. */
  autoJoin: boolean;
  googleClientId: string | null;
  ai: { provider: Provider; model: string };
}

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${label}: an object is required`);
  return value as Record<string, unknown>;
}

export function normalizeDomain(value: unknown): string {
  const domain = typeof value === "string" ? value.trim().replace(/^@/, "").toLowerCase() : "";
  if (!DOMAIN.test(domain)) throw new HttpError(400, "domain: not a valid domain (e.g. acme.example)");
  return domain;
}

function parseAi(value: unknown): { provider: Provider; model: string } {
  const o = object(value, "ai");
  if (o.provider !== "mistral" && o.provider !== "openai") throw new HttpError(400, 'ai.provider: "mistral" or "openai"');
  if (typeof o.model !== "string" || !MODEL.test(o.model.trim())) throw new HttpError(400, "ai.model: invalid model name");
  return { provider: o.provider, model: o.model.trim() };
}

/** `{clientId, clientSecret}`, or the JSON downloaded from Google Cloud (`{"installed": {…}}`). */
export function parseGoogleClient(value: unknown): GoogleClient {
  const o = object(value, "google");
  if (o.web !== undefined) throw new HttpError(400, 'google: this is a "Web application" client; diMail needs a "Desktop app" client');
  const source = o.installed !== undefined ? object(o.installed, "google.installed") : o;
  const clientId = String(source.clientId ?? source.client_id ?? "").trim();
  const clientSecret = String(source.clientSecret ?? source.client_secret ?? "").trim();
  if (!CLIENT_ID.test(clientId)) throw new HttpError(400, "google.clientId: not a Google OAuth client id");
  if (!CLIENT_SECRET.test(clientSecret)) throw new HttpError(400, "google.clientSecret: missing or malformed");
  return { clientId, clientSecret };
}

// MARK: Storage

export async function loadMail(env: Env): Promise<MailSettings> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'mail'").first<{ value: string }>();
  let stored: Record<string, unknown> = {};
  try {
    stored = row ? (JSON.parse(row.value) as Record<string, unknown>) : {};
  } catch {
    stored = {};
  }
  let ai = DEFAULT_MAIL_AI;
  try {
    if (stored.ai !== undefined) ai = parseAi(stored.ai);
  } catch {
    ai = DEFAULT_MAIL_AI;
  }
  return {
    domain: typeof stored.domain === "string" && stored.domain ? stored.domain : null,
    autoJoin: stored.autoJoin === true,
    googleClientId: typeof stored.googleClientId === "string" && stored.googleClientId ? stored.googleClientId : null,
    ai,
  };
}

async function saveMail(env: Env, settings: MailSettings, userId: string | null): Promise<void> {
  await put(env, "mail", settings, userId);
}

async function putSecret(env: Env, name: string, value: string, userId: string | null): Promise<void> {
  const { ciphertext, iv } = await encryptKey(secretOf(env), name, value);
  await env.DB.prepare(
    `INSERT INTO secrets (name, ciphertext, iv, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(name, ciphertext, iv, Date.now(), userId)
    .run();
}

async function getSecret(env: Env, name: string): Promise<{ value: string; updatedAt: number } | null> {
  const row = await env.DB.prepare("SELECT ciphertext, iv, updated_at FROM secrets WHERE name = ?1")
    .bind(name)
    .first<{ ciphertext: string; iv: string; updated_at: number }>();
  if (!row) return null;
  return { value: await decryptKey(secretOf(env), name, row.ciphertext, row.iv), updatedAt: row.updated_at };
}

/** The organization's Google client; 409 while diMail isn't set up on this server. */
export async function googleClient(env: Env, settings?: MailSettings): Promise<GoogleClient> {
  const mail = settings ?? (await loadMail(env));
  const secret = mail.googleClientId ? await getSecret(env, GOOGLE_SECRET) : null;
  if (!mail.googleClientId || !secret) throw new HttpError(409, "diMail isn't set up on this server yet: ask your admin");
  return { clientId: mail.googleClientId, clientSecret: secret.value };
}

async function saveGoogleClient(env: Env, mail: MailSettings, client: GoogleClient, userId: string | null): Promise<MailSettings> {
  await putSecret(env, GOOGLE_SECRET, client.clientSecret, userId);
  const next = { ...mail, googleClientId: client.clientId };
  await saveMail(env, next, userId);
  return next;
}

function parseAiKey(value: unknown): string {
  if (typeof value !== "string" || !KEY.test(value.trim())) throw new HttpError(400, "the key doesn't look like an API key");
  return value.trim();
}

// MARK: Members

/** A member who signed in with Google, by verified email. */
async function memberByEmail(db: D1Database, email: string) {
  return db
    .prepare("SELECT id, name, email, role, revoked_at FROM users WHERE email = ?1")
    .bind(email)
    .first<{ id: string; name: string; email: string; role: string; revoked_at: number | null }>();
}

async function createMember(db: D1Database, identity: GoogleIdentity, role: Role, invitedBy: string | null): Promise<User> {
  const name = identity.name ? normalizeName(identity.name) : identity.email.split("@")[0]!.slice(0, 80);
  const member: User = { id: crypto.randomUUID(), name, email: identity.email, role };
  // users.token_hash is diVoice's token and can't be empty: a hash nobody holds the token of.
  const unused = await sha256Hex(`unused:${crypto.randomUUID()}:${crypto.randomUUID()}`);
  await db
    .prepare(
      `INSERT INTO users (id, name, email, role, token_hash, created_at, invited_by, legacy_token)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)`,
    )
    .bind(member.id, member.name, member.email, role, unused, Date.now(), invitedBy)
    .run();
  return member;
}

/** Counts one use of the invite, unless someone took the last one first. */
async function claimInvite(db: D1Database, code: string): Promise<void> {
  const claimed = await db
    .prepare("UPDATE invites SET uses = uses + 1 WHERE code = ?1 AND revoked_at IS NULL AND expires_at > ?2 AND (max_uses IS NULL OR uses < max_uses)")
    .bind(code, Date.now())
    .run();
  if (!claimed.meta.changes) throw new HttpError(410, "this invite was already used: ask for a new one");
}

function inviteAdmits(invite: Invite, email: string): boolean {
  if (invite.kind === "personal") return invite.email === email;
  return !invite.emails || invite.emails.includes(email);
}

function inDomain(mail: MailSettings, identity: GoogleIdentity): boolean {
  return !!mail.domain && identity.email.endsWith(`@${mail.domain}`) && identity.hostedDomain === mail.domain;
}

export interface MailJoin {
  token: string;
  member: User;
  org: { name: string; server: string };
}

/**
 * "Sign in with Google" in diMail: `{idToken, code?}`.
 * - An active member signs in on a new Mac without an invite.
 * - Someone new needs an invite that admits their address, or, with auto-join on, a verified
 *   address of the organization's domain.
 * - A removed member needs a new invite: auto-join doesn't let them back in.
 */
export async function joinMail(env: Env, body: unknown, origin: string): Promise<MailJoin> {
  const o = object(body, "body");
  const mail = await loadMail(env);
  const client = await googleClient(env, mail);
  const identity = await verifyIdToken(o.idToken, client.clientId);
  const invite = typeof o.code === "string" && o.code ? await usableInvite(env.DB, o.code) : null;
  const settings = await loadSettings(env);
  const org = { name: settings.name, server: origin };
  const existing = await memberByEmail(env.DB, identity.email);

  if (existing && existing.revoked_at === null) {
    const role: Role = existing.role === "admin" ? "admin" : "member";
    const token = await newMemberToken(env.DB, existing.id, "dimail");
    return { token, member: { id: existing.id, name: existing.name, email: existing.email, role }, org };
  }

  if (invite && !inviteAdmits(invite, identity.email)) {
    throw new HttpError(
      403,
      invite.kind === "personal"
        ? `this invite is for ${invite.email}: you signed in as ${identity.email}`
        : `this invite is for other addresses: you signed in as ${identity.email}`,
    );
  }

  if (existing) {
    // Removed earlier: back in only with a new invite.
    if (!invite) throw new HttpError(403, `you were removed from ${settings.name}: ask an admin for a new invite`);
    await claimInvite(env.DB, invite.code);
    const role: Role = existing.role === "admin" || invite.role === "admin" ? "admin" : "member";
    await env.DB.prepare("UPDATE users SET revoked_at = NULL, role = ?2 WHERE id = ?1").bind(existing.id, role).run();
    const token = await newMemberToken(env.DB, existing.id, "dimail");
    return { token, member: { id: existing.id, name: existing.name, email: existing.email, role }, org };
  }

  if (invite) {
    await claimInvite(env.DB, invite.code);
    const member = await createMember(env.DB, identity, invite.role, invite.createdBy);
    return { token: await newMemberToken(env.DB, member.id, "dimail"), member, org };
  }
  if (mail.autoJoin && inDomain(mail, identity)) {
    const member = await createMember(env.DB, identity, "member", null);
    return { token: await newMemberToken(env.DB, member.id, "dimail"), member, org };
  }
  throw new HttpError(
    403,
    mail.autoJoin && mail.domain
      ? `${settings.name} admits @${mail.domain} addresses: you signed in as ${identity.email}. Ask an admin for an invite`
      : `you're not a member of ${settings.name}: ask an admin for an invite`,
  );
}

/**
 * The admin sets diMail up on this server, from diMail: `{secret, idToken, google, orgName?,
 * domain?, autoJoin?, ai?: {provider, model, key?}}`. The server secret proves they own the
 * server, so this works on a new server and on one that already has admins (diVoice's).
 * The admin is created, or promoted if they're already a member.
 */
export async function setupMail(env: Env, body: unknown, origin: string, checkSecret: (secret: unknown) => void): Promise<MailJoin> {
  const o = object(body, "body");
  checkSecret(o.secret);
  const client = parseGoogleClient(o.google);
  const identity = await verifyIdToken(o.idToken, client.clientId);
  const current = await loadMail(env);
  const domain = o.domain !== undefined && o.domain !== null && o.domain !== "" ? normalizeDomain(o.domain) : identity.hostedDomain;
  if (o.autoJoin !== undefined && typeof o.autoJoin !== "boolean") throw new HttpError(400, "autoJoin: true or false");
  const autoJoin = o.autoJoin === true;
  if (autoJoin && !domain) throw new HttpError(400, "autoJoin needs a domain");
  const ai = o.ai !== undefined ? parseAi(o.ai) : current.ai;
  const aiKey = o.ai !== undefined && (o.ai as Record<string, unknown>).key !== undefined ? parseAiKey((o.ai as Record<string, unknown>).key) : null;

  let member: User;
  const existing = await memberByEmail(env.DB, identity.email);
  if (existing) {
    await env.DB.prepare("UPDATE users SET role = 'admin', revoked_at = NULL WHERE id = ?1").bind(existing.id).run();
    member = { id: existing.id, name: existing.name, email: existing.email, role: "admin" };
  } else {
    member = await createMember(env.DB, identity, "admin", null);
  }

  if (o.orgName !== undefined) {
    if (typeof o.orgName !== "string" || !o.orgName.trim() || o.orgName.trim().length > 60) throw new HttpError(400, "orgName: 1 to 60 characters");
    await put(env, "org", { name: o.orgName.trim() }, member.id);
  }
  await saveGoogleClient(env, { domain, autoJoin, googleClientId: current.googleClientId, ai }, client, member.id);
  if (aiKey) await putSecret(env, AI_KEY, aiKey, member.id);

  const settings = await loadSettings(env);
  const token = await newMemberToken(env.DB, member.id, "dimail");
  return { token, member, org: { name: settings.name, server: origin } };
}

/** What a member's diMail needs, fetched at launch, every hour and when the provider refuses the key. */
export async function mailConfig(env: Env, user: User, origin: string) {
  const mail = await loadMail(env);
  const client = await googleClient(env, mail);
  const settings = await loadSettings(env);
  const key = await getSecret(env, AI_KEY);
  return {
    member: user,
    org: { name: settings.name, server: origin, domain: mail.domain, autoJoin: mail.autoJoin },
    domains: mail.domain ? [mail.domain] : [],
    google: client,
    ai: { provider: mail.ai.provider, model: mail.ai.model, key: key?.value ?? null, updatedAt: key?.updatedAt ?? null },
  };
}

/** What anyone about to sign in needs: the organization and its Google client. */
export async function publicOrg(env: Env, origin: string) {
  const mail = await loadMail(env);
  const client = await googleClient(env, mail);
  const settings = await loadSettings(env);
  return {
    org: { name: settings.name, server: origin, domain: mail.domain, autoJoin: mail.autoJoin },
    google: client,
  };
}

// MARK: Admin

export async function adminMail(env: Env) {
  const mail = await loadMail(env);
  const settings = await loadSettings(env);
  const row = await env.DB.prepare("SELECT updated_at FROM secrets WHERE name = ?1").bind(AI_KEY).first<{ updated_at: number }>();
  const google = await env.DB.prepare("SELECT updated_at FROM secrets WHERE name = ?1").bind(GOOGLE_SECRET).first<{ updated_at: number }>();
  return {
    name: settings.name,
    domain: mail.domain,
    autoJoin: mail.autoJoin,
    google: { clientId: mail.googleClientId, updatedAt: google?.updated_at ?? null },
    ai: { provider: mail.ai.provider, model: mail.ai.model, keySet: !!row, keyUpdatedAt: row?.updated_at ?? null },
  };
}

/** `{domain?, autoJoin?, ai?: {provider, model}}`. */
export async function updateAdminMail(env: Env, user: User, body: unknown) {
  const o = object(body, "body");
  const mail = await loadMail(env);
  const next = { ...mail };
  if (o.domain !== undefined) next.domain = o.domain === null || o.domain === "" ? null : normalizeDomain(o.domain);
  if (o.autoJoin !== undefined) {
    if (typeof o.autoJoin !== "boolean") throw new HttpError(400, "autoJoin: true or false");
    next.autoJoin = o.autoJoin;
  }
  if (next.autoJoin && !next.domain) throw new HttpError(400, "autoJoin needs a domain");
  if (o.ai !== undefined) next.ai = parseAi(o.ai);
  await saveMail(env, next, user.id);
  return adminMail(env);
}

/** A new Google client: members will have to sign in again (their tokens belong to the old one). */
export async function replaceGoogleClient(env: Env, user: User, body: unknown) {
  await saveGoogleClient(env, await loadMail(env), parseGoogleClient(body), user.id);
  return adminMail(env);
}

/** A new AI key, `{key}`: members get it at their next configuration refresh. */
export async function replaceAiKey(env: Env, user: User, body: unknown) {
  await putSecret(env, AI_KEY, parseAiKey(object(body, "body").key), user.id);
  return adminMail(env);
}

export async function removeAiKey(env: Env) {
  await env.DB.prepare("DELETE FROM secrets WHERE name = ?1").bind(AI_KEY).run();
  return adminMail(env);
}
