# diServer

The organization server of [diVoice](https://github.com/tommasoseita/divoice) and
[diMail](https://github.com/tommasoseita/diMail). An admin sets it up once; colleagues join with a link
and sign in, and their apps get everything else from it: keys, models, the Google client, the team
dictionary. The same organization and the same members work in both apps.

One deployment is one organization: a Cloudflare Worker with a D1 database, in your own Cloudflare
account. There is no central service.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tommasoseita/diServer/tree/main/deploy)

## What it keeps, and what it never sees

| Kept, in your D1 database | Never stored |
|---|---|
| The organization: name, email domain, settings | Emails, subjects, attachments, contacts |
| Members: name, email, role, last seen and with which app | Gmail tokens: they stay in each Mac's Keychain |
| Invites | Dictated audio or text |
| diMail's Google OAuth client and AI key, encrypted | Requests to the AI providers made by diMail |
| diVoice's AI keys (encrypted), models, team dictionary, statistics without text | |

diMail never sends mail through the server: each Mac talks to Gmail and to the AI provider
directly, with the configuration the server hands out. diVoice's dictations pass through the server's
relay, which adds the key and never writes the text anywhere.

## Quick start

1. Click **Deploy to Cloudflare** above. Cloudflare copies the small [`deploy/`](deploy) template to
   your GitHub account (the code comes from the `diserver` package), creates the Worker and its
   database, and asks for two values:
   - `SERVER_SECRET`: 32 or more random characters (`openssl rand -base64 36`). Keep a copy in your
     password manager.
   - `ORG_NAME`: your organization's name.
2. Wait for the deploy to finish and note the Worker's address, e.g.
   `https://diserver.acme.workers.dev`. The database is created in the European Union unless you
   choose otherwise ([where the data lives](docs/setup.md#where-the-data-lives)).
3. Set up the organization from the app:
   - **diMail**: Settings › Organization › Create an organization. Enter the address and the server
     secret; diMail uploads your Google client and, if you want, the AI key, and gives you the invite
     link.
   - **diVoice**: claim the server with the secret, then invite yourself as admin
     ([docs/setup.md](docs/setup.md#divoice-first-admin)).

The full guide, also for deploying by hand: [docs/setup.md](docs/setup.md). The API: [docs/api.md](docs/api.md).
Updates arrive as Dependabot pull requests in your copy of the template: merging one deploys it.
What changed: [CHANGELOG.md](CHANGELOG.md).

## Use in your own Worker

The server is the npm package `diserver`. A Worker that only re-exports it is a complete server:

```ts
// src/index.ts
export { default } from "diserver";
```

with a D1 binding named `DB` whose `migrations_dir` is `node_modules/diserver/migrations` (see
[`deploy/wrangler.jsonc`](deploy/wrangler.jsonc)), and the `SERVER_SECRET` secret.

## Development

```bash
npm install
npm test            # Workers runtime, with a local D1 (vitest + @cloudflare/vitest-plugin)
npm run typecheck
npm run dev         # wrangler dev, with a local database
npm run check:template   # packs the package and tries deploy/ with it, publishing nothing
```

The repository root is the `diserver` package; `deploy/` is the template behind the button;
`wrangler.test.toml` serves the tests and `npm run dev`. Migrations in `migrations/` only add tables
and columns, so updating a server is always "migrate, then deploy". Versions:
[docs/releasing.md](docs/releasing.md).

## License

[MIT](LICENSE). Copyright © 2026 Tommaso Seita.
