import type { App, Role, User } from "./env";
import { randomCode, sha256Hex } from "./util";

interface CacheEntry {
  user: User;
  expires: number;
}

// Per-isolate cache: avoids a D1 query on every request. A revocation takes effect within CACHE_MS.
const CACHE_MS = 60_000;
const cache = new Map<string, CacheEntry>();

export function clearAuthCache(): void {
  cache.clear();
}

export function bearerToken(header: string | null | undefined): string | null {
  const match = header?.match(/^Bearer\s+([A-Za-z0-9_\-]{20,200})$/);
  return match?.[1] ?? null;
}

/** A new member token: shown once to the app, only its SHA-256 is stored. */
export async function newToken(): Promise<{ token: string; hash: string }> {
  const token = `dv_${randomCode(32)}`;
  return { token, hash: await sha256Hex(token) };
}

/** A token for one app on one Mac (diMail); diVoice keeps its own in users.token_hash. */
export async function newMemberToken(db: D1Database, userId: string, app: App): Promise<string> {
  const { token, hash } = await newToken();
  await db
    .prepare("INSERT INTO member_tokens (hash, user_id, app, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(hash, userId, app, Date.now())
    .run();
  return token;
}

/**
 * The member behind a token: diVoice's (users.token_hash) or one of member_tokens. A removed
 * member's tokens stop working, all of them.
 */
export async function authenticate(
  db: D1Database,
  header: string | null | undefined,
  onFirstSeen?: (work: Promise<unknown>) => void,
): Promise<User | null> {
  const token = bearerToken(header);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const hit = cache.get(hash);
  if (hit && hit.expires > Date.now()) return hit.user;

  type Row = { id: string; name: string; email: string; role: string; app: string | null };
  const row =
    (await db
      .prepare("SELECT id, name, email, role, NULL AS app FROM users WHERE token_hash = ?1 AND revoked_at IS NULL")
      .bind(hash)
      .first<Row>()) ??
    (await db
      .prepare(
        `SELECT u.id, u.name, u.email, u.role, t.app FROM member_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.hash = ?1 AND t.revoked_at IS NULL AND u.revoked_at IS NULL`,
      )
      .bind(hash)
      .first<Row>());
  if (!row) {
    cache.delete(hash);
    return null;
  }
  const role: Role = row.role === "admin" ? "admin" : "member";
  const user: User = { id: row.id, name: row.name, email: row.email, role };
  cache.set(hash, { user, expires: Date.now() + CACHE_MS });
  const now = Date.now();
  const seen = [db.prepare("UPDATE users SET last_seen_at = ?2 WHERE id = ?1").bind(user.id, now)];
  if (row.app) seen.push(db.prepare("UPDATE member_tokens SET last_seen_at = ?2 WHERE hash = ?1").bind(hash, now));
  onFirstSeen?.(db.batch(seen));
  return user;
}
