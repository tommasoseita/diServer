import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearAuthCache } from "../src/auth";
import type { Env } from "../src/env";
import { setGoogleKeyFetcher, verifyIdToken } from "../src/google";
import { appDownload, inviteFileName } from "../src/pages";
import { call, createUser, resetOrg } from "./helpers";

const CLIENT = { clientId: "123456789012-abcdefgh12345678.apps.googleusercontent.com", clientSecret: "GOCSPX-test-secret_123" };
const SECRET = (env as unknown as Env).DIVOICE_SECRET!;
const AI_KEY = "mistral-key-0123456789abcdef";

let signer: CryptoKey;
let stranger: CryptoKey;

function b64url(bytes: ArrayBuffer | Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  let binary = "";
  for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A Google ID token for `email`, signed like Google's (or by another key, to test the check). */
async function idToken(email: string, claims: Record<string, unknown> = {}, key: CryptoKey = signer): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      aud: CLIENT.clientId,
      sub: email,
      email,
      email_verified: true,
      name: email.split("@")[0],
      iat: now,
      exp: now + 3600,
      ...claims,
    }),
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(signature)}`;
}

beforeAll(async () => {
  const algorithm = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const pair = (await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"])) as CryptoKeyPair;
  const other = (await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"])) as CryptoKeyPair;
  signer = pair.privateKey;
  stranger = other.privateKey;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  setGoogleKeyFetcher(async () => ({ keys: [{ kid: "test-key", kty: "RSA", alg: "RS256", n: jwk.n!, e: jwk.e! }], maxAgeMs: 3_600_000 }));
});

afterAll(() => setGoogleKeyFetcher(null));

beforeEach(async () => {
  clearAuthCache();
  await resetOrg();
});

type Json = Record<string, any>;

async function setup(email = "ada@acme.example", extra: Json = {}) {
  const response = await call("/v2/mail/setup", {
    method: "POST",
    json: { secret: SECRET, idToken: await idToken(email, { hd: "acme.example" }), google: CLIENT, orgName: "Acme", ...extra },
  });
  return { response, body: (await response.json()) as Json };
}

async function join(email: string, claims: Json = {}, code?: string) {
  const response = await call("/v2/mail/join", { method: "POST", json: { idToken: await idToken(email, claims), code } });
  return { status: response.status, body: (await response.json()) as Json };
}

describe("Google ID tokens", () => {
  it("are accepted only when signed by Google, for this client, unexpired and verified", async () => {
    const ok = await verifyIdToken(await idToken("Bob@Acme.example", { hd: "acme.example" }), CLIENT.clientId);
    expect(ok).toMatchObject({ email: "bob@acme.example", hostedDomain: "acme.example" });

    const reject = async (token: string, status: number) =>
      expect(verifyIdToken(token, CLIENT.clientId)).rejects.toMatchObject({ status });
    await reject(await idToken("bob@acme.example", {}, stranger), 401);
    await reject(await idToken("bob@acme.example", { aud: "other.apps.googleusercontent.com" }), 401);
    await reject(await idToken("bob@acme.example", { exp: Math.floor(Date.now() / 1000) - 3600 }), 401);
    await reject(await idToken("bob@acme.example", { iss: "https://evil.example" }), 401);
    await reject(await idToken("bob@acme.example", { email_verified: false }), 403);
    await reject("not.a.token", 401);
  });
});

describe("setting up diMail", () => {
  it("needs the server secret, then makes the admin and hands out the configuration", async () => {
    const wrong = await call("/v2/mail/setup", {
      method: "POST",
      json: { secret: "x".repeat(40), idToken: await idToken("ada@acme.example"), google: CLIENT },
    });
    expect(wrong.status).toBe(403);
    expect((await call("/v2/mail/org")).status).toBe(409);

    const { response, body } = await setup("ada@acme.example", { autoJoin: true, ai: { provider: "mistral", model: "mistral-small-2603", key: AI_KEY } });
    expect(response.status).toBe(201);
    expect(body.member).toMatchObject({ email: "ada@acme.example", role: "admin" });
    expect(body.org).toEqual({ name: "Acme", server: "https://team.example.com" });

    const config = (await (await call("/v2/mail/config", { token: body.token })).json()) as Json;
    expect(config.google).toEqual(CLIENT);
    expect(config.domains).toEqual(["acme.example"]);
    expect(config.ai).toMatchObject({ provider: "mistral", model: "mistral-small-2603", key: AI_KEY });
    expect(config.org).toMatchObject({ name: "Acme", domain: "acme.example", autoJoin: true });

    // The secret is stored encrypted, never in clear.
    const stored = await env.DB.prepare("SELECT ciphertext FROM secrets WHERE name = 'mail.ai_key'").first<{ ciphertext: string }>();
    expect(stored?.ciphertext).not.toContain("mistral-key");

    const pub = (await (await call("/v2/mail/org")).json()) as Json;
    expect(pub).toMatchObject({ org: { name: "Acme", domain: "acme.example", autoJoin: true }, google: CLIENT });
    expect(JSON.stringify(pub)).not.toContain(AI_KEY);
  });

  it("promotes a diVoice member and leaves their diVoice token working", async () => {
    const { user, token: divoice } = await createUser("member", "Ada");
    const { body } = await setup(user.email);
    expect(body.member).toMatchObject({ id: user.id, role: "admin" });
    expect((await call("/v2/me", { token: divoice })).status).toBe(200);
    expect((await call("/v2/admin/mail", { token: body.token })).status).toBe(200);
  });
});

describe("signing in from diMail", () => {
  it("lets an existing member in on a new Mac, without an invite, next to their diVoice token", async () => {
    await setup();
    const { user, token: divoice } = await createUser("member", "Bob");
    const first = await join(user.email);
    const second = await join(user.email);
    expect(first.status).toBe(201);
    expect(first.body.member).toMatchObject({ id: user.id, role: "member" });
    expect(second.body.token).not.toBe(first.body.token);
    for (const token of [divoice, first.body.token, second.body.token]) expect((await call("/v2/me", { token })).status).toBe(200);
  });

  it("admits newcomers with an invite for diMail, and only the address it names", async () => {
    const { body: admin } = await setup();
    const created = await call("/v2/admin/invites", { token: admin.token, method: "POST", json: { kind: "team", app: "dimail" } });
    const link = ((await created.json()) as Json).invite;
    expect(link.app).toBe("dimail");
    const info = (await (await call(`/v2/mail/invites/${link.code}`)).json()) as Json;
    expect(info).toMatchObject({ org: { name: "Acme" }, google: CLIENT, inviter: "ada", kind: "team" });

    const carla = await join("carla@gmail.com", {}, link.code);
    expect(carla.status).toBe(201);
    expect(carla.body.member).toMatchObject({ email: "carla@gmail.com", role: "member", name: "carla" });

    const personal = ((await (await call("/v2/admin/invites", { token: admin.token, method: "POST", json: { kind: "personal", app: "dimail", name: "Dario", email: "dario@partner.example" } })).json()) as Json).invite;
    const wrong = await join("mallory@partner.example", {}, personal.code);
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toContain("dario@partner.example");
    expect((await join("dario@partner.example", {}, personal.code)).status).toBe(201);
    expect((await join("eve@partner.example", {}, personal.code)).status).toBe(410);
  });

  it("admits the domain on its own only with auto-join, and only Workspace accounts of it", async () => {
    await setup();
    expect((await join("bob@acme.example", { hd: "acme.example" })).status).toBe(403);

    const { body: admin } = await setup("ada@acme.example", { autoJoin: true });
    const bob = await join("bob@acme.example", { hd: "acme.example" });
    expect(bob.status).toBe(201);
    // A consumer account can't claim the domain, and other domains need an invite.
    expect((await join("bob2@acme.example")).status).toBe(403);
    const outsider = await join("eve@other.example", { hd: "other.example" });
    expect(outsider.status).toBe(403);
    expect(outsider.body.error).toContain("@acme.example");

    const members = ((await (await call("/v2/admin/members", { token: admin.token })).json()) as Json).members as Json[];
    expect(members.map((m) => [m.email, m.apps])).toEqual(
      expect.arrayContaining([["ada@acme.example", ["dimail"]], ["bob@acme.example", ["dimail"]]]),
    );
  });

  it("locks out a removed member everywhere until a new invite", async () => {
    const { body: admin } = await setup("ada@acme.example", { autoJoin: true });
    const bob = await join("bob@acme.example", { hd: "acme.example" });
    expect((await call("/v2/mail/config", { token: bob.body.token })).status).toBe(200);

    expect((await call(`/v2/admin/members/${bob.body.member.id}`, { token: admin.token, method: "DELETE" })).status).toBe(204);
    clearAuthCache();
    expect((await call("/v2/mail/config", { token: bob.body.token })).status).toBe(401);
    const back = await join("bob@acme.example", { hd: "acme.example" });
    expect(back.status).toBe(403);
    expect(back.body.error).toContain("removed");

    const invite = ((await (await call("/v2/admin/invites", { token: admin.token, method: "POST", json: { kind: "personal", app: "dimail", name: "Bob", email: "bob@acme.example" } })).json()) as Json).invite;
    const rejoined = await join("bob@acme.example", { hd: "acme.example" }, invite.code);
    expect(rejoined.status).toBe(201);
    clearAuthCache();
    expect((await call("/v2/mail/config", { token: rejoined.body.token })).status).toBe(200);
    expect((await call("/v2/mail/config", { token: bob.body.token })).status).toBe(401);
  });
});

describe("the admin", () => {
  it("replaces the AI key and the model, and every member gets them", async () => {
    const { body: admin } = await setup("ada@acme.example", { autoJoin: true });
    const bob = await join("bob@acme.example", { hd: "acme.example" });
    let config = (await (await call("/v2/mail/config", { token: bob.body.token })).json()) as Json;
    expect(config.ai.key).toBeNull();

    expect((await call("/v2/admin/mail/ai-key", { token: bob.body.token, method: "PUT", json: { key: AI_KEY } })).status).toBe(403);
    const saved = (await (await call("/v2/admin/mail/ai-key", { token: admin.token, method: "PUT", json: { key: "sk-new-openai-key-0123456789" } })).json()) as Json;
    expect(saved.ai.keySet).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("sk-new");
    const patched = await call("/v2/admin/mail", { token: admin.token, method: "PATCH", json: { ai: { provider: "openai", model: "gpt-5.4-mini" } } });
    expect(patched.status).toBe(200);

    config = (await (await call("/v2/mail/config", { token: bob.body.token })).json()) as Json;
    expect(config.ai).toMatchObject({ provider: "openai", model: "gpt-5.4-mini", key: "sk-new-openai-key-0123456789" });

    expect((await call("/v2/admin/mail", { token: admin.token, method: "PATCH", json: { domain: null, autoJoin: true } })).status).toBe(400);
    expect((await call("/v2/admin/mail/google", { token: admin.token, method: "PUT", json: { web: { client_id: "x" } } })).status).toBe(400);
    const replaced = await call("/v2/admin/mail/google", {
      token: admin.token,
      method: "PUT",
      json: { installed: { client_id: "999999999999-zyxwvuts98765432.apps.googleusercontent.com", client_secret: "GOCSPX-other" } },
    });
    expect(((await replaced.json()) as Json).google.clientId).toBe("999999999999-zyxwvuts98765432.apps.googleusercontent.com");
  });
});

describe("pages", () => {
  it("send diMail invites to diMail, and leave diVoice's as they were", async () => {
    const { body: admin } = await setup();
    const mail = ((await (await call("/v2/admin/invites", { token: admin.token, method: "POST", json: { kind: "team", app: "dimail" } })).json()) as Json).invite;
    const voice = ((await (await call("/v2/admin/invites", { token: admin.token, method: "POST", json: { kind: "team" } })).json()) as Json).invite;
    expect(voice.app).toBe("divoice");

    const mailPage = await (await call(`/i/${mail.code}`)).text();
    expect(mailPage).toContain("Join Acme on diMail");
    expect(mailPage).toContain(`dimail://join?server=${encodeURIComponent("https://team.example.com")}&amp;code=${mail.code}`);
    const voicePage = await (await call(`/i/${voice.code}`)).text();
    expect(voicePage).toContain("Join Acme on diVoice");
    expect(voicePage).toContain("divoice://join");

    const org = await (await call("/dimail", { headers: { "Accept-Language": "it-IT" } })).text();
    expect(org).toContain("Acme su diMail");
    expect(org).toContain("dimail://join?server=");
    expect(inviteFileName("Acme", "team.example.com", "abc", "dimail")).toBe("diMail (Acme) [team.example.com abc].dmg");
    expect(inviteFileName("Acme", "team.example.com", "", "dimail")).toBe("diMail (Acme) [team.example.com].dmg");
  });

  it("download diMail from its release under the invite's name", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(url);
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Length": "3" } });
    }) as unknown as typeof fetch;
    const response = await appDownload(env as unknown as Env, "dimail", "diMail (Acme) [h c].dmg", fake);
    expect(seen).toEqual(["https://github.com/tommasoseita/diMail/releases/latest/download/diMail.dmg"]);
    expect(response.headers.get("Content-Disposition")).toContain("diMail (Acme) [h c].dmg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
