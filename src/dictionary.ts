import type { User } from "./env";
import { HttpError } from "./errors";

/**
 * The team dictionary: names and terms everyone's dictation should spell right. Members
 * read it (the app merges it with their personal one, which stays on their Mac); admins edit it.
 * Same JSON as the app's VocabularyEntry.
 */

export interface TeamEntry {
  id: string;
  term: string;
  aliases: string[];
  note: string | null;
  scope: "team";
  source: "seed" | "manual" | "learned";
  enabled: boolean;
  usageCount: number;
}

interface Row {
  id: string;
  term: string;
  aliases: string;
  note: string | null;
  source: string;
  enabled: number;
  usage_count: number;
}

function rowToEntry(row: Row): TeamEntry {
  let aliases: string[] = [];
  try {
    const parsed = JSON.parse(row.aliases) as unknown;
    if (Array.isArray(parsed)) aliases = parsed.filter((a): a is string => typeof a === "string");
  } catch {
    aliases = [];
  }
  return {
    id: row.id,
    term: row.term,
    aliases,
    note: row.note,
    scope: "team",
    source: row.source === "seed" ? "seed" : row.source === "learned" ? "learned" : "manual",
    enabled: row.enabled === 1,
    usageCount: row.usage_count,
  };
}

export async function teamEntries(db: D1Database): Promise<TeamEntry[]> {
  const { results } = await db
    .prepare("SELECT id, term, aliases, note, source, enabled, usage_count FROM dictionary_entries WHERE scope = 'team' ORDER BY lower(term)")
    .all<Row>();
  return results.map(rowToEntry);
}

function term(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "term: required");
  const t = value.trim().replace(/\s+/g, " ");
  if (t.length < 1 || t.length > 80) throw new HttpError(400, "term: 1 to 80 characters");
  return t;
}

function aliases(value: unknown, termValue: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new HttpError(400, "aliases: a list of up to 20");
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw new HttpError(400, "aliases: text only");
    const alias = raw.trim().replace(/\s+/g, " ").toLowerCase();
    if (alias.length < 1 || alias.length > 80) throw new HttpError(400, "aliases: 1 to 80 characters each");
    if (alias !== termValue.toLowerCase() && !out.includes(alias)) out.push(alias);
  }
  return out;
}

function note(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 200) throw new HttpError(400, "note: up to 200 characters");
  return value.trim() || null;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

async function entry(db: D1Database, id: string): Promise<TeamEntry> {
  const row = await db
    .prepare("SELECT id, term, aliases, note, source, enabled, usage_count FROM dictionary_entries WHERE id = ?1 AND scope = 'team'")
    .bind(id)
    .first<Row>();
  if (!row) throw new HttpError(404, "entry not found");
  return rowToEntry(row);
}

export async function createTeamEntry(db: D1Database, admin: User, body: unknown): Promise<TeamEntry> {
  const o = (body ?? {}) as Record<string, unknown>;
  const t = term(o.term);
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await db
      .prepare(
        `INSERT INTO dictionary_entries (id, scope, owner_id, term, aliases, note, source, enabled, created_by, created_at, updated_at)
         VALUES (?1, 'team', NULL, ?2, ?3, ?4, 'manual', 1, ?5, ?6, ?6)`,
      )
      .bind(id, t, JSON.stringify(aliases(o.aliases, t)), note(o.note), admin.id, now)
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, `"${t}" is already in the team dictionary`);
    throw err;
  }
  return entry(db, id);
}

export async function updateTeamEntry(db: D1Database, id: string, body: unknown): Promise<TeamEntry> {
  const current = await entry(db, id);
  const o = (body ?? {}) as Record<string, unknown>;
  const t = o.term !== undefined ? term(o.term) : current.term;
  const a = o.aliases !== undefined ? aliases(o.aliases, t) : current.aliases;
  const n = o.note !== undefined ? note(o.note) : current.note;
  const enabled = o.enabled !== undefined ? o.enabled === true : current.enabled;
  try {
    await db
      .prepare("UPDATE dictionary_entries SET term = ?2, aliases = ?3, note = ?4, enabled = ?5, updated_at = ?6 WHERE id = ?1")
      .bind(id, t, JSON.stringify(a), n, enabled ? 1 : 0, Date.now())
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, `"${t}" is already in the team dictionary`);
    throw err;
  }
  return entry(db, id);
}

export async function deleteTeamEntry(db: D1Database, id: string): Promise<void> {
  const result = await db.prepare("DELETE FROM dictionary_entries WHERE id = ?1 AND scope = 'team'").bind(id).run();
  if (!result.meta.changes) throw new HttpError(404, "entry not found");
}
