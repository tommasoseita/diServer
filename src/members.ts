import type { App, Role, User } from "./env";
import { HttpError } from "./errors";

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  createdAt: number;
  lastSeenAt: number | null;
  hideFromTeam: boolean;
  /** The apps the member is connected with. */
  apps: App[];
}

interface Row {
  id: string;
  name: string;
  email: string;
  role: string;
  created_at: number;
  last_seen_at: number | null;
  hide_from_team: number;
  legacy_token?: number;
  dimail?: number;
}

function rowToMember(row: Row): Member {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role === "admin" ? "admin" : "member",
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    hideFromTeam: row.hide_from_team === 1,
    apps: [...(row.legacy_token === 0 ? [] : (["divoice"] as App[])), ...(row.dimail ? (["dimail"] as App[]) : [])],
  };
}

/** Active members, admins first, then by name. */
export async function listMembers(db: D1Database): Promise<Member[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, email, role, created_at, last_seen_at, hide_from_team, legacy_token,
         EXISTS (SELECT 1 FROM member_tokens t WHERE t.user_id = users.id AND t.app = 'dimail' AND t.revoked_at IS NULL) AS dimail
       FROM users WHERE revoked_at IS NULL ORDER BY role = 'admin' DESC, lower(name)`,
    )
    .all<Row>();
  return results.map(rowToMember);
}

async function activeAdmins(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin' AND revoked_at IS NULL").first<{ n: number }>();
  return row?.n ?? 0;
}

async function member(db: D1Database, id: string): Promise<Row> {
  const row = await db
    .prepare("SELECT id, name, email, role, created_at, last_seen_at, hide_from_team FROM users WHERE id = ?1 AND revoked_at IS NULL")
    .bind(id)
    .first<Row>();
  if (!row) throw new HttpError(404, "member not found");
  return row;
}

export async function setRole(db: D1Database, id: string, role: unknown): Promise<Member> {
  if (role !== "admin" && role !== "member") throw new HttpError(400, 'role: "admin" or "member"');
  const row = await member(db, id);
  if (row.role === "admin" && role === "member" && (await activeAdmins(db)) <= 1) {
    throw new HttpError(409, "the organization needs at least one admin");
  }
  await db.prepare("UPDATE users SET role = ?2 WHERE id = ?1").bind(id, role).run();
  return rowToMember({ ...row, role });
}

/** Removes a member: their token stops working (within a minute, for cached requests). */
export async function removeMember(db: D1Database, admin: User, id: string): Promise<void> {
  const row = await member(db, id);
  if (row.role === "admin" && (await activeAdmins(db)) <= 1) throw new HttpError(409, "the organization needs at least one admin");
  if (id === admin.id && (await activeAdmins(db)) <= 1) throw new HttpError(409, "you are the only admin");
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE users SET revoked_at = ?2 WHERE id = ?1").bind(id, now),
    // diMail's tokens too: if the member is let back in, the old ones stay dead.
    db.prepare("UPDATE member_tokens SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL").bind(id, now),
  ]);
}

export async function setHideFromTeam(db: D1Database, userId: string, hide: unknown): Promise<void> {
  if (typeof hide !== "boolean") throw new HttpError(400, "hideFromTeam: true or false");
  await db.prepare("UPDATE users SET hide_from_team = ?2 WHERE id = ?1").bind(userId, hide ? 1 : 0).run();
}

export async function hideFromTeam(db: D1Database, userId: string): Promise<boolean> {
  const row = await db.prepare("SELECT hide_from_team FROM users WHERE id = ?1").bind(userId).first<{ hide_from_team: number }>();
  return row?.hide_from_team === 1;
}

/** The first admin of a new deployment, created with SERVER_SECRET (see setup). */
export async function hasAdmin(db: D1Database): Promise<boolean> {
  return (await activeAdmins(db)) > 0;
}
