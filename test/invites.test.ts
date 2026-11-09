import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { clearAuthCache } from "../src/auth";
import type { Env } from "../src/env";
import { inviteDownload, inviteFileName } from "../src/pages";
import { call, createUser, resetOrg } from "./helpers";

beforeEach(async () => {
  clearAuthCache();
  await resetOrg();
});

async function invite(token: string, json: unknown) {
  const response = await call("/v2/admin/invites", { token, method: "POST", json });
  expect(response.status).toBe(201);
  return ((await response.json()) as { invite: Record<string, any> }).invite;
}

describe("team links", () => {
  it("let colleagues join with their name and email, then work as a token", async () => {
    const { token: admin } = await createUser("admin", "Ada Admin");
    const link = await invite(admin, { kind: "team" });
    expect(link.url).toBe(`https://team.example.com/i/${link.code}`);
    expect(link.code).toMatch(/^[A-Za-z0-9_-]{16}$/);

    const info = (await (await call(`/v2/invites/${link.code}`)).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ inviter: "Ada Admin", kind: "team", needsEmail: true, org: { server: "https://team.example.com" } });

    const joined = await call("/v2/join", { method: "POST", json: { code: link.code, name: "Bob Rossi", email: "Bob@Example.com" } });
    expect(joined.status).toBe(201);
    const body = (await joined.json()) as { token: string; member: { email: string; role: string } };
    expect(body.member).toMatchObject({ email: "bob@example.com", role: "member" });
    expect((await call("/v2/me", { token: body.token })).status).toBe(200);

    // A second colleague can use the same link; an existing member can't take over an address.
    expect((await call("/v2/join", { method: "POST", json: { code: link.code, name: "Carla", email: "carla@example.com" } })).status).toBe(201);
    const takeover = await call("/v2/join", { method: "POST", json: { code: link.code, name: "Mallory", email: "bob@example.com" } });
    expect(takeover.status).toBe(409);
    expect(((await takeover.json()) as { error: string }).error).toContain("personal invite");
  });

  it("limited to addresses accept only those, once each", async () => {
    const { token: admin } = await createUser("admin");
    const link = await invite(admin, { kind: "team", emails: ["anna@example.com", "luca@example.com"] });
    expect(link.maxUses).toBe(2);
    expect((await call("/v2/join", { method: "POST", json: { code: link.code, name: "Eve", email: "eve@example.com" } })).status).toBe(403);
    expect((await call("/v2/join", { method: "POST", json: { code: link.code, name: "Anna", email: "anna@example.com" } })).status).toBe(201);
    expect((await call("/v2/join", { method: "POST", json: { code: link.code, name: "Luca", email: "luca@example.com" } })).status).toBe(201);
    expect((await call(`/v2/invites/${link.code}`)).status).toBe(410);
  });

  it("stop working when revoked or expired", async () => {
    const { token: admin } = await createUser("admin");
    const link = await invite(admin, { kind: "team" });
    expect((await call(`/v2/admin/invites/${link.code}`, { token: admin, method: "DELETE" })).status).toBe(204);
    expect((await call(`/v2/invites/${link.code}`)).status).toBe(410);

    const old = await invite(admin, { kind: "team" });
    await env.DB.prepare("UPDATE invites SET expires_at = 1 WHERE code = ?1").bind(old.code).run();
    const response = await call("/v2/join", { method: "POST", json: { code: old.code, name: "Late", email: "late@example.com" } });
    expect(response.status).toBe(410);
    expect((await call("/v2/invites/AAAAAAAAAAAAAAAA")).status).toBe(404);
    expect(((await (await call("/v2/admin/invites", { token: admin })).json()) as { invites: unknown[] }).invites).toEqual([]);
  });
});

describe("personal invites", () => {
  it("need no fields, work once and reconnect an existing member", async () => {
    const { token: admin } = await createUser("admin");
    const personal = await invite(admin, { kind: "personal", name: "Giulia Bianchi", email: "giulia@example.com" });
    const info = (await (await call(`/v2/invites/${personal.code}`)).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ kind: "personal", name: "Giulia Bianchi", email: "giulia@example.com", needsEmail: false });

    const first = await call("/v2/join", { method: "POST", json: { code: personal.code } });
    expect(first.status).toBe(201);
    const { token: oldToken } = (await first.json()) as { token: string };
    expect((await call("/v2/join", { method: "POST", json: { code: personal.code } })).status).toBe(410);

    // New Mac: a new personal invite replaces the token.
    const again = await invite(admin, { kind: "personal", name: "Giulia Bianchi", email: "giulia@example.com" });
    const second = await call("/v2/join", { method: "POST", json: { code: again.code } });
    const { token: newToken, member } = (await second.json()) as { token: string; member: { name: string } };
    expect(member.name).toBe("Giulia Bianchi");
    clearAuthCache();
    expect((await call("/v2/me", { token: oldToken })).status).toBe(401);
    expect((await call("/v2/me", { token: newToken })).status).toBe(200);
  });

  it("can make an admin, and need a name and a valid email", async () => {
    const { token: admin } = await createUser("admin");
    const promoted = await invite(admin, { kind: "personal", name: "Second Admin", email: "boss@example.com", role: "admin" });
    const joined = (await (await call("/v2/join", { method: "POST", json: { code: promoted.code } })).json()) as { member: { role: string } };
    expect(joined.member.role).toBe("admin");
    expect((await call("/v2/admin/invites", { token: admin, method: "POST", json: { kind: "personal", email: "x@example.com" } })).status).toBe(400);
    expect((await call("/v2/admin/invites", { token: admin, method: "POST", json: { kind: "personal", name: "X", email: "nope" } })).status).toBe(400);
    expect((await call("/v2/admin/invites", { token: admin, method: "POST", json: { kind: "team", days: 90 } })).status).toBe(400);
  });
});

describe("download name", () => {
  it("carries the server and the code, with a readable organization name", () => {
    expect(inviteFileName("Acme", "divoice.example.workers.dev", "AbCdEfGh12_-xyZ0")).toBe("diVoice (Acme) [divoice.example.workers.dev AbCdEfGh12_-xyZ0].dmg");
    expect(inviteFileName('Acme/"Co" <Milano>', "localhost:8787", "AbCdEfGh12_-xyZ0")).toBe("diVoice (AcmeCo Milano) [localhost:8787 AbCdEfGh12_-xyZ0].dmg");
    expect(inviteFileName("", "team.example.com", "AbCdEfGh12_-xyZ0")).toBe("diVoice [team.example.com AbCdEfGh12_-xyZ0].dmg");
  });
});

describe("invite page", () => {
  it("shows the organization, the inviter and both buttons, in the visitor's language", async () => {
    const { token: admin } = await createUser("admin", "Ada <Admin>");
    await call("/v2/admin/settings", { token: admin, method: "PATCH", json: { name: "Acme & Co" } });
    const link = await invite(admin, { kind: "team" });
    const html = await (await call(`/i/${link.code}`, { headers: { "Accept-Language": "en-US,en;q=0.9" } })).text();
    expect(html).toContain("Join Acme &amp; Co on diVoice");
    expect(html).toContain("Ada &lt;Admin&gt; invited you");
    expect(html).toContain(`href="/i/${link.code}/download"`);
    expect(html).toContain(`divoice://join?server=${encodeURIComponent("https://team.example.com")}&amp;code=${link.code}`);

    const italian = await (await call(`/i/${link.code}`, { headers: { "Accept-Language": "it-IT,it;q=0.9" } })).text();
    expect(italian).toContain("Scarica diVoice");
    const gone = await (await call("/i/AAAAAAAAAAAAAAAA")).text();
    expect(gone).toContain("doesn&#39;t exist");
  });

  it("downloads the stored build, or the public one, only for a valid invite", async () => {
    const { token: admin } = await createUser("admin");
    const link = await invite(admin, { kind: "team" });
    const typed = env as unknown as Env;

    await typed.UPDATES!.put("updates/diVoice.dmg", "DMG-BYTES", { metadata: { size: 9 } });
    const stored = await call(`/i/${link.code}/download`);
    expect(stored.headers.get("Content-Disposition")).toBe(
      `attachment; filename="diVoice (diVoice) [team.example.com ${link.code}].dmg"; filename*=UTF-8''${encodeURIComponent(`diVoice (diVoice) [team.example.com ${link.code}].dmg`)}`,
    );
    expect(await stored.text()).toBe("DMG-BYTES");
    await typed.UPDATES!.delete("updates/diVoice.dmg");

    const requested: string[] = [];
    const proxied = await inviteDownload(typed, link.code, { orgName: "Acme", host: "team.example.com" }, (async (url: string) => {
      requested.push(url);
      return new Response("PUBLIC-DMG");
    }) as unknown as typeof fetch);
    expect(requested).toEqual(["https://github.com/tommasoseita/divoice/releases/latest/download/diVoice.dmg"]);
    expect(await proxied.text()).toBe("PUBLIC-DMG");

    const invalid = await call("/i/AAAAAAAAAAAAAAAA/download");
    expect(invalid.status).toBe(302);
    expect(invalid.headers.get("Location")).toBe("/i/AAAAAAAAAAAAAAAA");
  });
});
