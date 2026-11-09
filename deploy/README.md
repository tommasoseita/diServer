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

The Deploy to Cloudflare button creates the database itself and **can't put it in the European
Union**: its form offers only a location hint, which is a preference, not a guarantee. For an
organization in Europe, create the database first with the European Union as its jurisdiction, then
pick it under **Select D1 database** in the button's form. Step by step:
[create the database in the EU](https://github.com/tommasoseita/diServer/blob/main/docs/setup.md#step-1-only-for-organizations-in-europe-create-the-database-in-the-eu).

To see where your database is: Cloudflare dashboard, **Storage & databases › D1 SQLite Database ›**
your database **› Settings › Jurisdiction**. A jurisdiction can't be added to an existing database.

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
