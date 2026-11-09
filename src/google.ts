import { HttpError } from "./errors";
import { base64ToBytes } from "./util";

/**
 * Google ID tokens (OpenID Connect), as diMail receives them at sign-in: the server checks them
 * itself, so a member's email is verified, unlike diVoice's typed-in address.
 * RS256 with Google's public keys, cached per isolate for as long as Google says.
 */

export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
/** Clock skew allowed between Google, the Mac and the server. */
const SKEW_S = 300;

export interface GoogleIdentity {
  email: string;
  /** The Workspace domain ("hd"), absent for consumer accounts. */
  hostedDomain: string | null;
  name: string | null;
  picture: string | null;
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

type KeyFetcher = () => Promise<{ keys: Jwk[]; maxAgeMs: number }>;

async function fetchGoogleKeys(): Promise<{ keys: Jwk[]; maxAgeMs: number }> {
  const response = await fetch(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new HttpError(502, "Google's keys aren't available right now: try again shortly");
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get("Cache-Control") ?? "")?.[1] ?? 3600);
  const body = (await response.json()) as { keys?: Jwk[] };
  return { keys: body.keys ?? [], maxAgeMs: Math.min(Math.max(maxAge, 60), 86_400) * 1000 };
}

let fetcher: KeyFetcher = fetchGoogleKeys;
let cached: { keys: Map<string, CryptoKey>; expires: number } | null = null;

/** Tests: Google's keys come from here instead of the network. */
export function setGoogleKeyFetcher(f: KeyFetcher | null): void {
  fetcher = f ?? fetchGoogleKeys;
  cached = null;
}

async function loadKeys(): Promise<Map<string, CryptoKey>> {
  const { keys, maxAgeMs } = await fetcher();
  const map = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    map.set(jwk.kid, key);
  }
  cached = { keys: map, expires: Date.now() + maxAgeMs };
  return map;
}

async function keyFor(kid: string): Promise<CryptoKey | undefined> {
  if (cached && cached.expires > Date.now() && cached.keys.has(kid)) return cached.keys.get(kid);
  // Unknown key id: Google may have rotated its keys since the last fetch.
  return (await loadKeys()).get(kid);
}

function decodePart(part: string): Record<string, unknown> {
  try {
    const padded = part.replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(new TextDecoder().decode(base64ToBytes(padded + "=".repeat((4 - (padded.length % 4)) % 4))));
  } catch {
    throw new HttpError(401, "the Google sign-in isn't valid: sign in again");
  }
}

function signatureBytes(part: string): Uint8Array {
  const padded = part.replaceAll("-", "+").replaceAll("_", "/");
  return base64ToBytes(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

/** The verified identity in a Google ID token issued for `clientId`; 401 otherwise. */
export async function verifyIdToken(idToken: unknown, clientId: string, now = Date.now()): Promise<GoogleIdentity> {
  const invalid = (why: string) => new HttpError(401, `the Google sign-in isn't valid (${why}): sign in again`);
  if (typeof idToken !== "string" || idToken.length > 4096) throw invalid("missing token");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw invalid("malformed token");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodePart(headerPart);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw invalid("unexpected algorithm");
  const key = await keyFor(header.kid);
  if (!key) throw invalid("unknown key");
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signatureBytes(signaturePart), signed);
  if (!ok) throw invalid("bad signature");

  const claims = decodePart(payloadPart);
  const seconds = now / 1000;
  if (!ISSUERS.has(String(claims.iss))) throw invalid("not issued by Google");
  if (claims.aud !== clientId) throw invalid("issued for another client");
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < seconds) throw invalid("expired");
  if (typeof claims.iat === "number" && claims.iat - SKEW_S > seconds) throw invalid("issued in the future");
  if (typeof claims.email !== "string" || !claims.email.includes("@")) throw invalid("no email");
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new HttpError(403, "Google hasn't verified this account's email");
  return {
    email: claims.email.trim().toLowerCase(),
    hostedDomain: typeof claims.hd === "string" ? claims.hd.toLowerCase() : null,
    name: typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 80) : null,
    picture: typeof claims.picture === "string" ? claims.picture : null,
  };
}
