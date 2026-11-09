# Setting up an organization server

One deployment of diServer is one organization. This guide covers deploying it (with one click or by
hand), setting the organization up from diMail or diVoice, and running it afterwards.

## Before you start

- A Cloudflare account. The **free plan** is enough for diMail. diVoice's relay keeps a WebSocket open
  for each dictation and calls the providers from it, which needs **Workers Paid**.
- For diMail: the organization's Google OAuth client of type **Desktop app**. For a Google Workspace,
  make it **Internal**: only your colleagues can sign in with it, and Google doesn't review it. How to
  create one: [diMail's guide](https://github.com/tommasoseita/diMail/blob/main/docs/CLIENT-GOOGLE.md).
- For the AI: an API key from Mistral or OpenAI. Use a key **dedicated to diMail**, with a **spending
  limit** set in the provider's console (see [The AI key](#the-ai-key)).

## Where the data lives

D1 can keep a database inside a **jurisdiction**: with `eu` it runs and stores its data only in the
European Union. That is a guarantee, unlike a *location hint* (`weur`, `eeur`…), which is only a
preference. A jurisdiction is chosen when the database is created and can't be changed afterwards.

The template creates the database **in the EU by default** (`"jurisdiction": "eu"` in
`deploy/wrangler.jsonc`, which needs wrangler 4.159 or later). That's the recommended choice for
organizations in Europe; elsewhere it still works, a little farther from your members. To choose
otherwise, before the **first** deploy either remove that line (Cloudflare's default location) or
create the database yourself and put its `database_id` in its place:

```bash
npx wrangler d1 create diserver --jurisdiction=eu      # or --location=wnam, enam, weur, eeur, apac, oc
```

After the first deploy, check it in the Cloudflare dashboard: Storage & databases › D1 › your
database shows its jurisdiction. If it isn't the one you wanted, delete the Worker and the database
and deploy again: there's nothing in it yet.

## Deploy with one click

1. Click the **Deploy to Cloudflare** button in the [README](../README.md) and sign in to Cloudflare.
2. Connect your GitHub account: Cloudflare copies the `deploy/` template to a repository of yours.
   It holds only your configuration; the code comes from the `diserver` npm package.
3. Fill in the form:
   - **SERVER_SECRET**: 32 or more random characters. Generate it with `openssl rand -base64 36`
     (diVoice's **Create an organization** generates one for you) and save it in your password
     manager first: you need it to set up the organization, and the server needs it to read the
     keys your admins save.
   - **ORG_NAME**: your organization's name, as invite pages will show it.
   - The Worker and database names can stay as they are.
4. Click **Create and deploy**. Cloudflare builds the template; its deploy script creates the D1
   database (in the EU, see above), deploys the Worker and applies the migrations. The address is
   shown at the end, e.g. `https://diserver.acme.workers.dev`.
5. Check it: `https://<your address>/v2/setup` answers `{"claimed":false,"secretConfigured":true}`.

To serve it from your own domain (e.g. `team.acme.example`), add a **Custom domain** in the Worker's
settings on Cloudflare. Invite links use whatever address members open.

## Deploy by hand

Start from a copy of the template:

```bash
git clone https://github.com/tommasoseita/diServer.git
cp -R diServer/deploy my-server && cd my-server
npm install
npx wrangler login
```

Set `ORG_NAME` in `wrangler.jsonc` (and choose the database's location, see above), then:

```bash
npm run deploy                                          # creates the database, deploys, migrates
openssl rand -base64 36 > secret.txt                    # keep a copy in your password manager
npx wrangler secret put SERVER_SECRET < secret.txt
rm secret.txt
```

`npm run deploy` applies the migrations before the new code whenever the database already exists;
only on the very first deploy do they follow it, because the database is created then.

## Set up the organization

### From diMail

The admin uses diMail first on their own, in personal mode, with the organization's Google client
and, if they want, the AI key. Then, in **Settings › Organization › Create an organization**:

1. Enter the server's address and `SERVER_SECRET`.
2. Check the name, the domain (taken from your address) and choose whether anyone with an address of
   the domain can join on their own.
3. Click **Create**. diMail sends the Google client, the AI key and model if you included them, and
   your Google sign-in. The server checks the secret and the sign-in and makes you an admin; if you
   were already a member (from diVoice) you keep your account and become an admin.
4. You get the **invite link** and the **organization link** (`https://<server>/dimail`).

The same works on a server that already has admins, for example one set up for diVoice: the secret
proves you own it.

### diVoice: first admin

Claim the server with the secret (once; afterwards the endpoint refuses):

```bash
curl -s https://<server>/v2/setup/claim -H "Content-Type: application/json" \
  -d '{"secret":"<SERVER_SECRET>","name":"Ada Lovelace","email":"ada@acme.example","orgName":"Acme"}'
```

With the `token` from the answer, create a personal invite for yourself and open its `url`:

```bash
curl -s https://<server>/v2/admin/invites -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"kind":"personal","name":"Ada Lovelace","email":"ada@acme.example","role":"admin"}'
```

## Inviting people

| Link | Who gets in | Valid |
|---|---|---|
| Team invite, `https://<server>/i/<code>` | Anyone with the link (or only the addresses you list) | 7 days |
| Personal invite, same form | One address | 14 days, once |
| diMail organization link, `https://<server>/dimail` | Existing members, always; anyone with an address of the domain if you turned that on | Permanent |

Each invite is for one app (`diMail` or `diVoice`): its page offers that app's download, named after
the invite so the app recognizes it at first launch. Membership is the same for both apps.

In diMail people sign in with Google, and the server verifies the Google sign-in itself: an address is
certain, so a member can sign in again on a new Mac from the organization link, and the domain can
admit people on its own. "Anyone with an address of the domain" means a Google Workspace account of
that domain: a consumer account that happens to use the address doesn't qualify.

## The AI key

diMail sends each request to the AI provider straight from the member's Mac, so mail never passes
through the server. The price of that: every member's diMail receives the organization's diMail key,
and a curious member could read it from their Keychain. So:

- create a key **only for diMail**, separate from the one diVoice uses;
- give it a **spending limit** in the provider's console, or put it in a project with a monthly
  budget, so a leaked key can't cost more than you decided;
- **replace it** after removing someone (diMail: Settings › Organization › AI › Replace the key).
  Members get the new key at their next refresh: at launch, every hour, and as soon as the provider
  refuses the old one.

diVoice's keys are different: the server never returns them, and its relay uses them.

## Removing a member

Admins remove members from the app. Within a minute all of the member's tokens stop working, in both
apps. diMail notices at its next launch: it leaves the organization, deletes the key and the
configuration from the Keychain and goes back to its first screen; the mail already on the Mac stays,
with an option to delete it. A removed member can come back only with a new invite.

## Updating

With the button, Dependabot opens a pull request in your copy of the template when a new version
of `diserver` is out. Read the [changelog](../CHANGELOG.md), merge it, and Cloudflare deploys the
update, migrations first. By hand:

```bash
npm update diserver
npm run deploy      # migrations first, then the Worker
```

Migrations only add tables and columns, so "migrate, then deploy" is always safe. When an app release
needs a newer server, its notes say so: update the server first.

## Backups

D1 keeps 30 days of history ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)):

```bash
npx wrangler d1 time-travel info diserver
npx wrangler d1 time-travel restore diserver --timestamp=<unix-or-iso>
npx wrangler d1 export diserver --remote --output diserver-backup.sql     # an off-site copy
```

The export holds members' names and emails, token hashes and the encrypted keys: store it like any
personal data. Without `SERVER_SECRET` the keys in it can't be decrypted.

## The server secret

- `SERVER_SECRET` encrypts the keys admins save (AES-GCM, with a key derived from it) and proves you
  own the server when you set up the organization.
- Servers deployed before diMail use `DIVOICE_SECRET` for the same purpose; it keeps working.
- Changing it makes the saved keys and the Google client unreadable: save them again afterwards.
  Members' tokens aren't affected.

## Recovering admin access

If every admin lost access, promote a member from the command line:

```bash
npx wrangler d1 execute diserver --remote \
  --command "UPDATE users SET role = 'admin' WHERE email = 'ada@acme.example'"
```

## What the server stores

| Table | Contents |
|---|---|
| `users` | Name, email, role, when they were removed, a hash of their diVoice token, who invited them |
| `member_tokens` | Hashes of diMail's tokens, one per Mac, with the app and when last seen |
| `invites` | Code, app, kind, role, allowed emails, uses, expiry, who created it |
| `settings` | Organization name, diMail's domain, auto-join and model, diVoice's models and leaderboard |
| `secrets` | diMail's Google client secret and AI key, encrypted |
| `provider_keys` | diVoice's AI keys, encrypted |
| `dictionary_entries` | diVoice's team dictionary |
| `dictation_events` | One row per dictation, with counts and timings: no text, no audio |
