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

D1, Cloudflare's database, can keep a database inside a **jurisdiction**. With the European Union as
its jurisdiction, a database runs and stores its data only in the EU: that is a guarantee. A
*location hint* (for example "Eastern Europe") is only a preference, and Cloudflare may place the
database elsewhere. The jurisdiction is chosen when the database is created and can't be changed
afterwards.

**The Deploy to Cloudflare button doesn't guarantee a database in the EU.** Its form creates the
database itself and offers only a location hint; the `"jurisdiction": "eu"` line in the template is
ignored there. We checked it on 9 November 2026: a database created by the button had no
jurisdiction. So:

- **Organizations in Europe**: first create the database yourself, with the European Union as its
  jurisdiction, then pick it in the button's form. Step by step below.
- **Elsewhere**: let the button create the database.

## Deploy with one click

### Step 1, only for organizations in Europe: create the database in the EU

1. **A Cloudflare account.** If you don't have one, open
   [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up), sign up with your work email
   and a password, and confirm the email Cloudflare sends you. The free plan is enough for diMail;
   diVoice needs Workers Paid (see [Before you start](#before-you-start)). If you have an account,
   sign in at [dash.cloudflare.com](https://dash.cloudflare.com).
2. In the menu on the left, under **Storage & databases**, click **D1 SQLite Database**. In a narrow
   window the menu hides behind the ☰ button at the top left.
3. Click **Create Database**.
4. **Name**: `diserver`.
5. Under **Data location**, choose **Specify jurisdiction**, click **Provide a jurisdiction**, and in
   **Location** pick **The European Union**.
6. Click **Create**. Cloudflare opens the new database.
7. Check it: on the database's page open **Settings**. **Jurisdiction** must show the European Union.
   If it shows **None**, delete the database (**Delete database**, at the bottom of the same page) and
   start again from point 3: it's still empty, and a jurisdiction can't be added later.

### Step 2: deploy with the button

1. Click **Deploy to Cloudflare** in the [README](../README.md). Sign in to Cloudflare if asked.
2. **Git account**: click **New GitHub connection**, sign in to GitHub and install the **Cloudflare
   Workers and Pages** app when GitHub asks. Cloudflare creates a repository in your GitHub account
   with your server's configuration (the code itself comes from the `diserver` npm package), and
   deploys again whenever that repository changes. Back in the form, pick your account under **Git
   account**. If Cloudflare brings you back to a page called **Select a repository** instead of the
   form, open the button's link again.
3. Tick **Create private Git repository**. Nothing in it is secret, but there's no reason to publish it.
4. **Project name**: the Worker's name, which is also the start of its address,
   `https://<project name>.<your subdomain>.workers.dev`. `diserver` is fine.
5. The database:
   - **in Europe**: open **Select D1 database** and choose `diserver`, the database from step 1,
     instead of **+ Create new**. Ignore **Name your D1 Database** and **Database location hint**;
   - **elsewhere**: leave **+ Create new**. **Database location hint** is optional.
6. **SERVER_SECRET**: 32 or more random characters. In Terminal run `openssl rand -base64 36`, or use
   the one diVoice's **Create an organization** generates. Save it in your password manager
   **before** pasting it: you need it to set up the organization, and Cloudflare never shows it again.
7. **ORG_NAME**: your organization's name, as invite pages will show it.
8. Leave the rest as it is: **Build command** empty, **Deploy command** `npm run deploy`.
9. Click **Deploy**. Cloudflare creates the repository, installs the server, applies the database
   migrations and deploys the Worker. The log ends with "Success! Build completed." and shows the
   address, for example `https://diserver.acme.workers.dev`. If Cloudflare first asks you to choose a
   `workers.dev` subdomain, pick a short name: it becomes part of the address.
10. Check the server: open `https://<your address>/v2/setup` in the browser. It answers
    `{"claimed":false,"secretConfigured":true}`. Right after the first deploy the address may take a
    few minutes to answer.
11. In Europe, check the database once more: **Storage & databases › D1 SQLite Database › diserver ›
    Settings**. **Jurisdiction** shows the European Union.

Afterwards you can limit the Cloudflare app to the new repository: on GitHub, **Settings ›
Applications › Installed GitHub Apps › Cloudflare Workers and Pages › Configure**, then **Only select
repositories**.

To serve the server from your own domain (e.g. `team.acme.example`), add a **Custom domain** in the
Worker's settings on Cloudflare. Invite links use whatever address members open.

## Deploy by hand

Start from a copy of the template:

```bash
git clone https://github.com/tommasoseita/diServer.git
cp -R diServer/deploy my-server && cd my-server
npm install
npx wrangler login
```

Create the database, in the EU if your members are in Europe:

```bash
npx wrangler d1 create diserver --jurisdiction=eu      # elsewhere: drop --jurisdiction=eu
```

In `wrangler.jsonc`, replace the `"jurisdiction": "eu"` line with the `"database_id"` that command
printed, and set `ORG_NAME`. Then:

```bash
npm run deploy                                          # migrations first, then the Worker
openssl rand -base64 36 > secret.txt                    # keep a copy in your password manager
npx wrangler secret put SERVER_SECRET < secret.txt
rm secret.txt
```

Without a `database_id`, `npm run deploy` lets wrangler create the database at the first deploy,
in the jurisdiction of the `"jurisdiction"` line (wrangler 4.159 or later), and applies the
migrations right after it. Creating it yourself, as above, lets you check where it is before anything
is deployed.

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
