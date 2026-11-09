import { newToken } from "./auth";
import type { App, Role, User } from "./env";
import { HttpError } from "./errors";
import { randomCode } from "./util";

/**
 * Invites: the admin creates a link, the colleague opens it and joins with one click.
 * - team: anyone with the link (or only the listed addresses), for a few days;
 * - personal: one use, name and email filled in. It also reconnects an existing member,
 *   for example on a new Mac: team links can't, since addresses aren't verified.
 */

export type InviteKind = "team" | "personal";

export interface Invite {
  code: string;
  kind: InviteKind;
  /** The app the link is for: its page and download. Membership is the same for both. */
  app: App;
  role: Role;
  name: string | null;
  email: string | null;
  emails: string[] | null;
  maxUses: number | null;
  uses: number;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

interface Row {
  code: string;
  kind: string;
  app?: string;
  role: string;
  name: string | null;
  email: string | null;
  emails: string | null;
  max_uses: number | null;
  uses: number;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

const DAY_MS = 86_400_000;
export const INVITE_CODE = /^[A-Za-z0-9_-]{16}$/;
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,24}$/;

function rowToInvite(row: Row): Invite {
  let emails: string[] | null = null;
  try {
    emails = row.emails ? (JSON.parse(row.emails) as string[]) : null;
  } catch {
    emails = null;
  }
  return {
    code: row.code,
    kind: row.kind === "personal" ? "personal" : "team",
    app: row.app === "dimail" ? "dimail" : "divoice",
    role: row.role === "admin" ? "admin" : "member",
    name: row.name,
    email: row.email,
    emails,
    maxUses: row.max_uses,
    uses: row.uses,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export function normalizeEmail(value: unknown, label = "email"): string {
  if (typeof value !== "string" || !EMAIL.test(value.trim())) throw new HttpError(400, `${label}: not a valid address`);
  return value.trim().toLowerCase();
}

export function normalizeName(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "name: required");
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 80) throw new HttpError(400, "name: 1 to 80 characters");
  return name;
}

export function isUsable(invite: Invite, now = Date.now()): boolean {
  return invite.revokedAt === null && invite.expiresAt > now && (invite.maxUses === null || invite.uses < invite.maxUses);
}

export async function createInvite(db: D1Database, admin: User, body: unknown): Promise<Invite> {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const kind: InviteKind = o.kind === "personal" ? "personal" : "team";
  if (o.app !== undefined && o.app !== "divoice" && o.app !== "dimail") throw new HttpError(400, 'app: "divoice" or "dimail"');
  const app: App = o.app === "dimail" ? "dimail" : "divoice";
  const role: Role = o.role === "admin" ? "admin" : "member";
  const days = o.days === undefined ? (kind === "team" ? 7 : 14) : Number(o.days);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new HttpError(400, "days: 1 to 30");

  let name: string | null = null;
  let email: string | null = null;
  let emails: string[] | null = null;
  let maxUses: number | null = null;
  if (kind === "personal") {
    name = normalizeName(o.name);
    email = normalizeEmail(o.email);
    maxUses = 1;
  } else if (o.emails !== undefined) {
    if (!Array.isArray(o.emails) || o.emails.length === 0 || o.emails.length > 100) {
      throw new HttpError(400, "emails: a list of 1 to 100 addresses");
    }
    emails = [...new Set(o.emails.map((e) => normalizeEmail(e, "emails")))];
    maxUses = emails.length;
  }

  const now = Date.now();
  const invite: Invite = {
    code: randomCode(12),
    kind,
    app,
    role,
    name,
    email,
    emails,
    maxUses,
    uses: 0,
    createdBy: admin.id,
    createdAt: now,
    expiresAt: now + days * DAY_MS,
    revokedAt: null,
  };
  await db
    .prepare(
      `INSERT INTO invites (code, kind, role, name, email, emails, max_uses, uses, created_by, created_at, expires_at, app)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?11)`,
    )
    .bind(invite.code, kind, role, name, email, emails ? JSON.stringify(emails) : null, maxUses, admin.id, now, invite.expiresAt, app)
    .run();
  return invite;
}

export async function findInvite(db: D1Database, code: string): Promise<Invite | null> {
  if (!INVITE_CODE.test(code)) return null;
  const row = await db.prepare("SELECT * FROM invites WHERE code = ?1").bind(code).first<Row>();
  return row ? rowToInvite(row) : null;
}

/** Invites that can still be used, newest first. */
export async function listInvites(db: D1Database): Promise<Invite[]> {
  const { results } = await db
    .prepare("SELECT * FROM invites WHERE revoked_at IS NULL AND expires_at > ?1 ORDER BY created_at DESC LIMIT 200")
    .bind(Date.now())
    .all<Row>();
  return results.map(rowToInvite).filter((invite) => isUsable(invite));
}

export async function revokeInvite(db: D1Database, code: string): Promise<void> {
  const result = await db.prepare("UPDATE invites SET revoked_at = ?2 WHERE code = ?1 AND revoked_at IS NULL").bind(code, Date.now()).run();
  if (!result.meta.changes) throw new HttpError(404, "invite not found");
}

/** A usable invite, or the reason it isn't. */
export async function usableInvite(db: D1Database, code: string): Promise<Invite> {
  const invite = await findInvite(db, code);
  if (!invite) throw new HttpError(404, "this invite doesn't exist");
  if (invite.revokedAt !== null) throw new HttpError(410, "this invite was revoked: ask for a new one");
  if (invite.expiresAt <= Date.now()) throw new HttpError(410, "this invite has expired: ask for a new one");
  if (invite.maxUses !== null && invite.uses >= invite.maxUses) throw new HttpError(410, "this invite was already used: ask for a new one");
  return invite;
}

export interface JoinResult {
  token: string;
  member: User;
}

/** Joins the organization with an invite: creates the member (or reconnects one) and returns a token. */
export async function join(db: D1Database, code: string, body: unknown): Promise<JoinResult> {
  const invite = await usableInvite(db, code);
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const email = invite.kind === "personal" ? invite.email! : normalizeEmail(o.email);
  const name = o.name !== undefined && o.name !== "" ? normalizeName(o.name) : invite.name ?? normalizeName(o.name);
  if (invite.emails && !invite.emails.includes(email)) {
    throw new HttpError(403, "this invite is for other addresses: check the email or ask for a personal invite");
  }

  // Count the use first: two people racing for the last use can't both get in.
  const claimed = await db
    .prepare("UPDATE invites SET uses = uses + 1 WHERE code = ?1 AND revoked_at IS NULL AND expires_at > ?2 AND (max_uses IS NULL OR uses < max_uses)")
    .bind(code, Date.now())
    .run();
  if (!claimed.meta.changes) throw new HttpError(410, "this invite was already used: ask for a new one");

  const existing = await db
    .prepare("SELECT id, name, role, revoked_at FROM users WHERE email = ?1")
    .bind(email)
    .first<{ id: string; name: string; role: string; revoked_at: number | null }>();
  const { token, hash } = await newToken();

  if (existing) {
    if (invite.kind !== "personal") {
      await db.prepare("UPDATE invites SET uses = uses - 1 WHERE code = ?1").bind(code).run();
      throw new HttpError(
        409,
        existing.revoked_at === null
          ? "this email is already a member: ask your admin for a personal invite to connect a new Mac"
          : "this email was removed from the organization: ask your admin for a personal invite",
      );
    }
    const role: Role = existing.role === "admin" || invite.role === "admin" ? "admin" : "member";
    await db
      .prepare("UPDATE users SET token_hash = ?2, revoked_at = NULL, role = ?3, legacy_token = 1 WHERE id = ?1")
      .bind(existing.id, hash, role)
      .run();
    return { token, member: { id: existing.id, name: existing.name, email, role } };
  }

  const member: User = { id: crypto.randomUUID(), name, email, role: invite.role };
  await db
    .prepare("INSERT INTO users (id, name, email, role, token_hash, created_at, invited_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(member.id, name, email, member.role, hash, Date.now(), invite.createdBy)
    .run();
  return { token, member };
}
