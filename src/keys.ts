import type { Env } from "./env";
import { HttpError } from "./errors";
import { base64ToBytes, bytesToBase64 } from "./util";
import type { Provider } from "./settings";

/**
 * Provider API keys entered by the admin: AES-GCM encrypted in D1 with a key derived from
 * SERVER_SECRET (or DIVOICE_SECRET), decrypted only to call the provider, never returned by the API.
 */

const encoder = new TextEncoder();

async function cipherKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("divoice"), info: encoder.encode("provider-keys") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** SERVER_SECRET, or DIVOICE_SECRET for deployments made before diMail; "" if neither is set. */
export function serverSecret(env: Env): string {
  return env.SERVER_SECRET?.trim() || env.DIVOICE_SECRET?.trim() || "";
}

export function secretOf(env: Env): string {
  const secret = serverSecret(env);
  if (secret.length < 32) {
    throw new HttpError(503, "the server's SERVER_SECRET is missing or shorter than 32 characters");
  }
  return secret;
}

/** `label` is bound to the ciphertext: a value can't be moved to another slot. */
export async function encryptKey(secret: string, label: string, key: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(label) },
    await cipherKey(secret),
    encoder.encode(key),
  );
  return { ciphertext: bytesToBase64(new Uint8Array(data)), iv: bytesToBase64(iv) };
}

export async function decryptKey(secret: string, label: string, ciphertext: string, iv: string): Promise<string> {
  const data = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv), additionalData: encoder.encode(label) },
    await cipherKey(secret),
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(data);
}

export const KEY = /^[A-Za-z0-9._\-]{20,300}$/;

// Decrypted keys stay in this isolate's memory for a minute: a dictation doesn't wait for a
// database read and a decryption. A key saved or removed elsewhere takes effect within a minute.
const KEY_CACHE_MS = 60_000;
const keyCache = new Map<Provider, { value: string | undefined; expires: number }>();

export function clearKeyCache(): void {
  keyCache.clear();
}

export async function saveProviderKey(env: Env, provider: Provider, key: unknown, userId: string): Promise<void> {
  if (typeof key !== "string" || !KEY.test(key.trim())) throw new HttpError(400, "the key doesn't look like an API key");
  const { ciphertext, iv } = await encryptKey(secretOf(env), provider, key.trim());
  await env.DB.prepare(
    `INSERT INTO provider_keys (provider, ciphertext, iv, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (provider) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(provider, ciphertext, iv, Date.now(), userId)
    .run();
  keyCache.delete(provider);
}

export async function removeProviderKey(env: Env, provider: Provider): Promise<void> {
  await env.DB.prepare("DELETE FROM provider_keys WHERE provider = ?1").bind(provider).run();
  keyCache.delete(provider);
}

/** The key to call a provider with: the admin's, otherwise the Worker secret; undefined if neither. */
export async function providerKey(env: Env, provider: Provider, now = Date.now()): Promise<string | undefined> {
  const cached = keyCache.get(provider);
  if (cached && cached.expires > now) return cached.value;
  const row = await env.DB.prepare("SELECT ciphertext, iv FROM provider_keys WHERE provider = ?1")
    .bind(provider)
    .first<{ ciphertext: string; iv: string }>();
  const fallback = provider === "mistral" ? env.MISTRAL_API_KEY : env.OPENAI_API_KEY;
  const value = row ? await decryptKey(secretOf(env), provider, row.ciphertext, row.iv) : fallback?.trim() || undefined;
  keyCache.set(provider, { value, expires: now + KEY_CACHE_MS });
  return value;
}

export interface KeyStatus {
  provider: Provider;
  /** "admin": saved from the app; "secret": a Worker secret; null: none. */
  source: "admin" | "secret" | null;
  updatedAt: number | null;
}

export async function keyStatus(env: Env): Promise<KeyStatus[]> {
  const { results } = await env.DB.prepare("SELECT provider, updated_at FROM provider_keys").all<{ provider: Provider; updated_at: number }>();
  return (["mistral", "openai"] as Provider[]).map((provider) => {
    const row = results.find((r) => r.provider === provider);
    if (row) return { provider, source: "admin", updatedAt: row.updated_at };
    const secret = provider === "mistral" ? env.MISTRAL_API_KEY : env.OPENAI_API_KEY;
    return { provider, source: secret?.trim() ? "secret" : null, updatedAt: null };
  });
}
