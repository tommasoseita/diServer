# Your organization's diServer

This repository runs your organization's server for [diVoice](https://github.com/tommasoseita/divoice)
and [diMail](https://github.com/tommasoseita/diMail) on Cloudflare Workers. The server keeps your
organization, its members and invites, and the configuration the apps need: keys, models, the Google
client. It never stores what anyone dictates, and mail never passes through it.

All the code comes from the [`diserver`](https://www.npmjs.com/package/diserver) package. This
repository only holds your deployment's configuration.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tommasoseita/diServer/tree/main/deploy)

## After deploying

1. Copy your server's address from Cloudflare, for example `https://diserver.acme.workers.dev`.
2. Set up the organization from the app:
   - **diMail**: Settings › Organization › Create an organization, with the address and `SERVER_SECRET`;
   - **diVoice**: finish **Create an organization** with the address, your name and email.
3. Invite your team from the app.

The full guide: [Setting up an organization server](https://github.com/tommasoseita/diServer/blob/main/docs/setup.md).

## Where the data lives

The database is created at the first deploy **in the European Union** (`"jurisdiction": "eu"` in
`wrangler.jsonc`): it runs and stores its data only there. A jurisdiction can't be changed after the
database exists. Outside Europe you may remove that line before the first deploy.

## Updates

Dependabot opens a pull request when a new version of `diserver` is published. Read the
[changelog](https://github.com/tommasoseita/diServer/blob/main/CHANGELOG.md), then merge it: Cloudflare
deploys the update, migrations first.

## Configuration

| Name | Where | Purpose |
|---|---|---|
| `SERVER_SECRET` | Secret (Workers › Settings › Variables and Secrets) | Encrypts the keys admins save and proves you own the server. Changing it means saving the keys again. |
| `ORG_NAME` | Variable in `wrangler.jsonc` | The organization's name until an admin renames it |
| `MISTRAL_BASE_URL` | Variable in `wrangler.jsonc` | `https://api.eu.mistral.ai` for Mistral's EU endpoint (diVoice's relay) |

## Working on it locally

```bash
npm install
cp .dev.vars.example .dev.vars   # then set SERVER_SECRET
npm run dev
```
