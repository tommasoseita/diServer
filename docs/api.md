# API

All endpoints return JSON. Authenticated endpoints take `Authorization: Bearer <token>`; tokens start with `dv_`, are shown once, and are stored only as hashes. diVoice holds one token per member; diMail one per Mac.

## Public (both apps)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | `{"ok": true}` |
| `GET` | `/i/:code` | The invite page (English or Italian, from `Accept-Language`) |
| `GET` | `/i/:code/download` | The app's disk image, named after the invite |
| `GET` | `/updates/:file` | Builds hosted in the `UPDATES` namespace |
| `GET` | `/v2/invites/:code` | What the app shows before joining: organization, inviter, kind, expiry |
| `POST` | `/v2/join` | `{code, name, email}` → `{token, member, org}` |
| `GET` | `/v2/setup` | `{claimed, secretConfigured}` |
| `POST` | `/v2/setup/claim` | `{secret, name, email, orgName}` → the first admin's `{token, member, org}`. Works once. |

## Members (both apps)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v2/me` | The member, the organization, the models (`pipeline`), the audio sample rate, whether the leaderboard is on |
| `PATCH` | `/v2/me` | `{hideFromTeam}` |
| `GET` | `/v2/dictionary` | The team dictionary |
| `GET` | `/v2/stats/me` | `?today=YYYY-MM-DD&days=N`: the member's words, time saved, speaking speed, streak. Dictations and Scribe both count; one without the member's local day counts on its UTC day |
| `GET` | `/v2/stats/team` | Same parameters: the leaderboard, empty when it's off |
| `GET` | `/v2/relay` | WebSocket: one dictation (see below) |

## Admins (both apps)

| Method | Path | Purpose |
|---|---|---|
| `GET`, `PATCH` | `/v2/admin/settings` | `{name, pipeline, leaderboardEnabled}`, plus which keys are set |
| `PUT`, `DELETE` | `/v2/admin/keys/:provider` | `mistral`, `openai` or `elevenlabs`; `PUT` takes `{key}`. Keys are never returned. `/v2/admin/settings` lists every provider the server takes a key for: the apps show the ones listed |
| `GET` | `/v2/admin/members` | All members, with the apps each one uses (`apps`) |
| `PATCH`, `DELETE` | `/v2/admin/members/:id` | `{role}`; remove. The last admin can't be demoted or removed. |
| `GET`, `POST` | `/v2/admin/invites` | List; create with `{kind: "team" \| "personal", app?: "divoice" \| "dimail", role, days, emails?, name?, email?}`. `app` (default `divoice`) picks the invite page and download |
| `DELETE` | `/v2/admin/invites/:code` | Revoke |
| `POST`, `PATCH`, `DELETE` | `/v2/dictionary[/:id]` | Edit the team dictionary |

## diVoice's relay

One WebSocket per dictation. The app keeps the prompts and the logic; the server adds the key and the models, keeps a copy of the audio so the transcription at release starts on the server with no second upload, and relays the app's cleanup or Scribe request on the same connection.

Transcription runs with Mistral (Voxtral) or ElevenLabs (Scribe v2: `scribe_v2_realtime` and `scribe_v2`, 16 kHz), as `pipeline.transcription.provider` says; cleanup and Scribe with Mistral or OpenAI. With ElevenLabs the dictionary goes in `keyterms`: the first 50 terms of up to 20 characters while streaming, the first 100 of up to 50 characters for the batch transcription (beyond 100, ElevenLabs bills each request at least 20 seconds).

App → server:

```text
{"type":"start", sessionId, sampleRate, language, vocabulary, purpose: "dictation" | "verify"}
binary frames: PCM s16le mono at sampleRate
{"type":"finish"}
{"type":"chat", id, role: "cleanup" | "scribe", body}     the provider request, built by the app
{"type":"stats", mode, category, words, localDay, typingWPM, cleanupPath, timings}
{"type":"cancel"} | {"type":"ping"}
```

Server → app:

```text
{"type":"ready", sessionId, sampleRate}
{"type":"partial", text}
{"type":"transcript", text, path, model, language, warning, timings}
{"type":"chat.line", id, line} … {"type":"chat.done", id, timings} | {"type":"chat.error", id, status, body}
{"type":"error", code, message}, then the server closes
```

The server only forwards known fields of a chat request; it sets the model, the service tier and predicted outputs from the organization's settings, and caps the response length (8,000 tokens for cleanup, 12,000 for Scribe). The provider gets a time that grows with the text of the request (every message but the system prompt): for Scribe 60 s plus 1 s per 40 characters, between 90 s and 300 s; for cleanup 8 s plus 1 s per 400 characters, between 20 s and 30 s. Past it the app receives a `chat.error` with status 502. A `start` without `sampleRate` opens a chat-only session, which Verify uses. Each member can start at most 60 dictations in 5 minutes.


## diMail

Mail never reaches the server: these endpoints only hand out configuration and manage membership.
Members sign in with Google; the server verifies the ID token (RS256 against Google's keys, issuer,
audience = the organization's client, expiry, verified email, `hd` for the domain).

### Public

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/dimail` | The organization page: download and "open diMail" (`dimail://join?server=…`) |
| `GET` | `/dimail/download` | diMail's disk image, named `diMail (Org) [host].dmg`. Back to `/dimail` while diMail isn't set up, and to `/dimail?download=unavailable` (a notice on the page) if the image can't be fetched |
| `GET` | `/v2/mail/org` | `{org: {name, server, domain, autoJoin}, google: {clientId, clientSecret}}`; 409 until diMail is set up |
| `GET` | `/v2/mail/invites/:code` | The same, plus `inviter`, `kind`, `email` (personal invites), `expiresAt` |
| `POST` | `/v2/mail/join` | `{idToken, code?}` → `{token, member, org}` (see below) |
| `POST` | `/v2/mail/setup` | `{secret, idToken, google, orgName?, domain?, autoJoin?, ai?: {provider, model, key?}}` → the admin's `{token, member, org}` |

`google` is `{clientId, clientSecret}` or the JSON downloaded from Google Cloud (`{"installed": {…}}`).
A desktop client's secret isn't confidential for Google (PKCE protects the sign-in), so the server
gives it to anyone about to sign in.

Who `join` lets in:

- an active member, always (a new Mac needs no invite);
- someone new with a valid invite that admits their address (personal: that address; team: anyone,
  or the listed addresses);
- someone new with auto-join on, whose Google account is a Workspace account of the domain;
- a removed member only with a new invite.

### Members

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v2/mail/config` | `{member, org, domains, google, ai: {provider, model, key, updatedAt}}`. diMail fetches it at launch, every hour and when the provider refuses the key; a 401 means the member was removed |

### Admins

| Method | Path | Purpose |
|---|---|---|
| `GET`, `PATCH` | `/v2/admin/mail` | `{domain, autoJoin, ai: {provider, model}}`; the answer also says which client and whether a key is set. The organization's name is in `/v2/admin/settings` |
| `PUT` | `/v2/admin/mail/google` | A new Google client: members have to sign in again |
| `PUT`, `DELETE` | `/v2/admin/mail/ai-key` | `{key}`: members get it at their next refresh. Never returned to admins |
