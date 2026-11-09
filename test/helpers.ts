import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env, User } from "../src/env";
import app from "../src/index";
import { sha256Hex } from "../src/util";

export async function call(path: string, init: RequestInit & { token?: string; json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(`https://team.example.com${path}`, { ...init, headers, body }), env as unknown as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

let counter = 0;

export async function createUser(role: "member" | "admin" = "member", name = "Test User"): Promise<{ user: User; token: string }> {
  counter++;
  const token = `dv_test_token_${counter}_${crypto.randomUUID().replaceAll("-", "")}`;
  const user: User = { id: crypto.randomUUID(), name, email: `user${counter}-${crypto.randomUUID().slice(0, 8)}@example.com`, role };
  await env.DB.prepare("INSERT INTO users (id, name, email, role, token_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(user.id, user.name, user.email, role, await sha256Hex(token), Date.now())
    .run();
  return { user, token };
}

/** Clears organization data between tests (users stay unique by construction). */
export async function resetOrg(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM settings"),
    env.DB.prepare("DELETE FROM provider_keys"),
    env.DB.prepare("DELETE FROM invites"),
    env.DB.prepare("DELETE FROM dictation_events"),
    env.DB.prepare("DELETE FROM dictionary_entries"),
    env.DB.prepare("DELETE FROM member_tokens"),
    env.DB.prepare("DELETE FROM secrets"),
    env.DB.prepare("DELETE FROM users"),
  ]);
}

export function silence(ms: number, sampleRate = 16_000): Uint8Array {
  return new Uint8Array(Math.round((ms / 1000) * sampleRate) * 2);
}

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
