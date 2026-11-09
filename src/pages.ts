import { DEFAULT_DIMAIL_DOWNLOAD_URL, DEFAULT_DOWNLOAD_URL, type App, type Env } from "./env";
import { findInvite, isUsable, type Invite } from "./invites";

/**
 * The page behind an invite link, and its download. The downloaded disk image is named after
 * the invite, "diVoice (Org) [host code].dmg": at its first launch diVoice reads the name of
 * the disk image it comes from (macOS no longer exposes where a download came from).
 */

const STRINGS = {
  en: {
    title: (org: string) => `Join ${org} on diVoice`,
    invited: (who: string, org: string) => `${who} invited you to ${org} on diVoice, voice dictation for the Mac.`,
    invitedNoName: (org: string) => `You're invited to ${org} on diVoice, voice dictation for the Mac.`,
    download: "Download diVoice",
    open: "I already have diVoice: open it",
    stepsTitle: "After downloading",
    steps: (org: string) => [
      "Open the diVoice disk image from your Downloads.",
      `Drag diVoice to Applications and open it, or double-click it right there: it recognizes this invite and asks you to join ${org}.`,
      "Allow the microphone and Accessibility, then hold Fn and speak.",
    ],
    notFound: "If diVoice doesn't show the invite (for example because you closed the disk image first), come back here and click “I already have diVoice”.",
    requirements: "Requires a Mac with Apple silicon and macOS 14 or later.",
    gone: "This invite has expired or was already used. Ask for a new one.",
    missing: "This invite doesn't exist. Check the link, or ask for a new one.",
  },
  it: {
    title: (org: string) => `Unisciti a ${org} su diVoice`,
    invited: (who: string, org: string) => `${who} ti ha invitato in ${org} su diVoice, la dettatura vocale per Mac.`,
    invitedNoName: (org: string) => `Sei invitato in ${org} su diVoice, la dettatura vocale per Mac.`,
    download: "Scarica diVoice",
    open: "Ho già diVoice: aprila",
    stepsTitle: "Dopo il download",
    steps: (org: string) => [
      "Apri l'immagine disco di diVoice dai Download.",
      `Trascina diVoice in Applicazioni e aprila, oppure fai doppio clic lì: riconosce questo invito e ti chiede di unirti a ${org}.`,
      "Consenti il microfono e l'Accessibilità, poi tieni premuto Fn e parla.",
    ],
    notFound: "Se diVoice non mostra l'invito (per esempio perché hai già chiuso l'immagine disco), torna qui e clicca “Ho già diVoice”.",
    requirements: "Serve un Mac con Apple silicon e macOS 14 o successivo.",
    gone: "Questo invito è scaduto o è già stato usato. Chiedine uno nuovo.",
    missing: "Questo invito non esiste. Controlla il link o chiedine uno nuovo.",
  },
};

/** diMail's invite pages: same layout, its own words and download. */
const DIMAIL_STRINGS: typeof STRINGS = {
  en: {
    title: (org: string) => `Join ${org} on diMail`,
    invited: (who: string, org: string) => `${who} invited you to ${org} on diMail, the Gmail client for the Mac.`,
    invitedNoName: (org: string) => `You're invited to ${org} on diMail, the Gmail client for the Mac.`,
    download: "Download diMail",
    open: "I already have diMail: open it",
    stepsTitle: "After downloading",
    steps: (org: string) => [
      "Open the diMail disk image from your Downloads.",
      `Drag diMail to Applications and open it, or double-click it right there: it recognizes this invite and asks you to join ${org}.`,
      "Click “Sign in with Google”: there's nothing to set up.",
    ],
    notFound: "If diMail doesn't show the invite (for example because you closed the disk image first), come back here and click “I already have diMail”.",
    requirements: "Requires a Mac.",
    gone: "This invite has expired or was already used. Ask for a new one.",
    missing: "This invite doesn't exist. Check the link, or ask for a new one.",
  },
  it: {
    title: (org: string) => `Unisciti a ${org} su diMail`,
    invited: (who: string, org: string) => `${who} ti ha invitato in ${org} su diMail, il client Gmail per Mac.`,
    invitedNoName: (org: string) => `Sei invitato in ${org} su diMail, il client Gmail per Mac.`,
    download: "Scarica diMail",
    open: "Ho già diMail: aprila",
    stepsTitle: "Dopo il download",
    steps: (org: string) => [
      "Apri l'immagine disco di diMail dai Download.",
      `Trascina diMail in Applicazioni e aprila, oppure fai doppio clic lì: riconosce questo invito e ti chiede di unirti a ${org}.`,
      "Premi «Accedi con Google»: non c'è altro da configurare.",
    ],
    notFound: "Se diMail non mostra l'invito (per esempio perché hai già chiuso l'immagine disco), torna qui e clicca «Ho già diMail».",
    requirements: "Serve un Mac.",
    gone: "Questo invito è scaduto o è già stato usato. Chiedine uno nuovo.",
    missing: "Questo invito non esiste. Controlla il link o chiedine uno nuovo.",
  },
};

/** The organization page of diMail (`/dimail`): no invite, sign in with Google. */
const ORG_STRINGS = {
  en: {
    title: (org: string) => `${org} on diMail`,
    intro: (org: string) => `${org} uses diMail, the Gmail client for the Mac. Your admin set it up: you only sign in.`,
    domain: (domain: string) => `Anyone with an @${domain} address can join.`,
    members: "Members of the organization can sign in here, also on a new Mac.",
    steps: [
      "Download diMail and drag it to Applications.",
      "Open it, or come back here and click “I already have diMail”.",
      "Click “Sign in with Google” with your work account.",
    ],
    unavailable: "diMail isn't set up on this server yet. Ask your admin.",
    downloadUnavailable: "The download isn't available right now. Try again in a few minutes, or ask your admin.",
  },
  it: {
    title: (org: string) => `${org} su diMail`,
    intro: (org: string) => `${org} usa diMail, il client Gmail per Mac. L'amministratore l'ha già configurato: tu accedi e basta.`,
    domain: (domain: string) => `Chi ha un indirizzo @${domain} può entrare.`,
    members: "Chi fa parte dell'organizzazione può accedere da qui, anche da un Mac nuovo.",
    steps: [
      "Scarica diMail e trascinalo in Applicazioni.",
      "Aprilo, oppure torna qui e clicca «Ho già diMail».",
      "Premi «Accedi con Google» con l'account di lavoro.",
    ],
    unavailable: "diMail non è ancora configurato su questo server. Chiedi all'amministratore.",
    downloadUnavailable: "Il download non è disponibile in questo momento. Riprova tra qualche minuto o chiedi all'amministratore.",
  },
};

function stringsFor(app: App) {
  return app === "dimail" ? DIMAIL_STRINGS : STRINGS;
}

type Language = keyof typeof STRINGS;

export function pageLanguage(acceptLanguage: string | null | undefined): Language {
  const first = acceptLanguage?.split(",")[0]?.trim().slice(0, 2).toLowerCase();
  return first === "it" ? "it" : "en";
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(language: Language, title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #f5f5f7; --card: #fff; --accent: #0071e3; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --bg: #1d1d1f; --card: #2c2c2e; --accent: #2997ff; } }
  body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 520px; margin: 8vh auto; padding: 32px 28px; background: var(--card); border-radius: 18px; }
  h1 { font-size: 26px; line-height: 1.2; margin: 0 0 12px; }
  p { margin: 0 0 16px; }
  .muted { color: var(--muted); font-size: 14px; }
  .button { display: block; text-align: center; padding: 12px 16px; border-radius: 12px; text-decoration: none; font-weight: 600; margin: 10px 0; }
  .primary { background: var(--accent); color: #fff; }
  .secondary { color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); }
  ol { padding-left: 20px; margin: 8px 0 16px; }
  li { margin: 4px 0; }
  h2 { font-size: 15px; margin: 24px 0 4px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  });
}

async function inviterName(db: D1Database, invite: Invite): Promise<string | null> {
  if (!invite.createdBy) return null;
  const row = await db.prepare("SELECT name FROM users WHERE id = ?1").bind(invite.createdBy).first<{ name: string }>();
  return row?.name ?? null;
}

export async function invitePage(env: Env, orgName: string, code: string, origin: string, acceptLanguage: string | null): Promise<Response> {
  const language = pageLanguage(acceptLanguage);
  const invite = await findInvite(env.DB, code);
  const t = stringsFor(invite?.app ?? "divoice")[language];
  if (!invite || !isUsable(invite)) {
    return page(language, t.title(orgName), `<h1>${escape(t.title(orgName))}</h1><p>${escape(invite ? t.gone : t.missing)}</p>`);
  }
  const who = await inviterName(env.DB, invite);
  const join = `${invite.app}://join?server=${encodeURIComponent(origin)}&code=${encodeURIComponent(code)}`;
  const body = `
<h1>${escape(t.title(orgName))}</h1>
<p>${escape(who ? t.invited(who, orgName) : t.invitedNoName(orgName))}</p>
<a class="button primary" href="/i/${escape(code)}/download">${escape(t.download)}</a>
<a class="button secondary" href="${escape(join)}">${escape(t.open)}</a>
<h2>${escape(t.stepsTitle)}</h2>
<ol>${t.steps(orgName).map((s) => `<li>${escape(s)}</li>`).join("")}</ol>
<p class="muted">${escape(t.notFound)}</p>
<p class="muted">${escape(t.requirements)}</p>`;
  return page(language, t.title(orgName), body);
}

/** "diVoice (Org) [host code].dmg": what the app reads at its first launch. diMail's start with "diMail". */
export function inviteFileName(orgName: string, host: string, code: string, app: App = "divoice"): string {
  const org = orgName.replace(/[^\p{L}\p{N} .&'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);
  const name = app === "dimail" ? "diMail" : "diVoice";
  return `${name}${org ? ` (${org})` : ""} [${host}${code ? ` ${code}` : ""}].dmg`;
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** The DMG for a valid invite: from this server's storage, or fetched from the public release. */
export async function inviteDownload(
  env: Env,
  code: string,
  options: { orgName: string; host: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const invite = await findInvite(env.DB, code);
  if (!invite || !isUsable(invite)) return new Response(null, { status: 302, headers: { Location: `/i/${code}` } });
  return appDownload(env, invite.app, inviteFileName(options.orgName, options.host, code, invite.app), fetchImpl);
}

/** The app's DMG under `fileName`: from this server's storage if there, otherwise from the release. */
export async function appDownload(env: Env, app: App, fileName: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const headers = new Headers({
    "Content-Type": "application/x-apple-diskimage",
    "Content-Disposition": contentDisposition(fileName),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  const label = app === "dimail" ? "diMail" : "diVoice";
  const stored = await env.UPDATES?.getWithMetadata<{ size?: number }>(`updates/${label}.dmg`, { type: "stream" });
  if (stored?.value) {
    if (typeof stored.metadata?.size === "number") headers.set("Content-Length", String(stored.metadata.size));
    return new Response(stored.value, { headers });
  }
  const url = app === "dimail" ? env.DIMAIL_DOWNLOAD_URL?.trim() || DEFAULT_DIMAIL_DOWNLOAD_URL : env.DOWNLOAD_URL?.trim() || DEFAULT_DOWNLOAD_URL;
  const upstream = await fetchImpl(url, { redirect: "follow" });
  if (!upstream.ok || !upstream.body) return new Response(`${label} isn't available for download right now`, { status: 502 });
  const length = upstream.headers.get("Content-Length");
  if (length) headers.set("Content-Length", length);
  return new Response(upstream.body, { headers });
}

/**
 * `/dimail/download`: diMail's disk image, named after the organization. While diMail isn't set up
 * on this server it goes back to `/dimail` without fetching anything; if the image can't be fetched,
 * back to `/dimail` with a notice, instead of an error page.
 */
export async function orgDownload(
  env: Env,
  orgName: string,
  host: string,
  configured: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const back = (location: string) => new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
  if (!configured) return back("/dimail");
  const response = await appDownload(env, "dimail", inviteFileName(orgName, host, "", "dimail"), fetchImpl);
  return response.ok ? response : back("/dimail?download=unavailable");
}

/** `/dimail`: the organization's permanent link for diMail. */
export function orgPage(
  orgName: string,
  origin: string,
  acceptLanguage: string | null,
  mail: { configured: boolean; domain: string | null; autoJoin: boolean },
  notice: "download-unavailable" | null = null,
): Response {
  const language = pageLanguage(acceptLanguage);
  const t = ORG_STRINGS[language];
  const d = DIMAIL_STRINGS[language];
  if (!mail.configured) return page(language, t.title(orgName), `<h1>${escape(t.title(orgName))}</h1><p>${escape(t.unavailable)}</p>`);
  const join = `dimail://join?server=${encodeURIComponent(origin)}`;
  const body = `
<h1>${escape(t.title(orgName))}</h1>
<p>${escape(t.intro(orgName))}</p>
<p class="muted">${escape(mail.autoJoin && mail.domain ? t.domain(mail.domain) : t.members)}</p>
${notice === "download-unavailable" ? `<p><strong>${escape(t.downloadUnavailable)}</strong></p>\n` : ""}<a class="button primary" href="/dimail/download">${escape(d.download)}</a>
<a class="button secondary" href="${escape(join)}">${escape(d.open)}</a>
<h2>${escape(d.stepsTitle)}</h2>
<ol>${t.steps.map((s) => `<li>${escape(s)}</li>`).join("")}</ol>
<p class="muted">${escape(d.requirements)}</p>`;
  return page(language, t.title(orgName), body);
}

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Sparkle updates for builds served by this server (pilots): appcast.xml and DMGs. */
export async function serveUpdate(env: Env, file: string): Promise<Response> {
  if (!env.UPDATES || !FILE_NAME.test(file) || file.includes("..")) return new Response("not found", { status: 404 });
  const { value, metadata } = await env.UPDATES.getWithMetadata<{ contentType?: string; size?: number }>(`updates/${file}`, { type: "stream" });
  if (!value) return new Response("not found", { status: 404 });
  const isAppcast = file.endsWith(".xml");
  const headers = new Headers({
    "Content-Type": metadata?.contentType ?? (isAppcast ? "application/xml; charset=utf-8" : "application/octet-stream"),
    // The appcast changes at each release; DMGs carry the version in their name.
    "Cache-Control": isAppcast ? "no-store" : "public, max-age=86400, immutable",
    "X-Content-Type-Options": "nosniff",
  });
  if (typeof metadata?.size === "number") headers.set("Content-Length", String(metadata.size));
  if (!isAppcast) headers.set("Content-Disposition", `attachment; filename="${file}"`);
  return new Response(value, { headers });
}
