# Changelog

diServer's versions are decided here, and only here: diVoice and diMail say in their release notes
which diServer version they need at least, and never set or bump it. See [docs/releasing.md](docs/releasing.md).

## Unreleased

- Docs: the Deploy to Cloudflare button doesn't put the database in the EU. It creates the database
  itself, with no jurisdiction, and ignores the template's `"jurisdiction": "eu"`. Organizations in
  Europe create the database first and pick it in the button's form:
  [docs/setup.md](docs/setup.md#where-the-data-lives). 0.5.0's notes below said otherwise.

## 0.5.0 (9 November 2026)

- **A neutral home.** The organization server leaves diVoice's repository: package `diserver`
  (it was `@divoice/server`, never published), repository `tommasoseita/diServer`, MIT license.
- **diMail.** Members sign in with Google and the server verifies the ID token (RS256 with Google's
  keys), so addresses are certain: a member signs in again on a new Mac without an invite, and an
  organization can admit its Workspace domain on its own. One token per app and Mac
  (`member_tokens`); removing a member revokes all of them. The organization's Google client and
  diMail's AI key are stored encrypted and handed to members; mail never reaches the server.
  Setup from diMail with the server secret, admin endpoints, diMail invite pages and the
  `/dimail` organization page. API in [docs/api.md](docs/api.md).
- **`SERVER_SECRET`** replaces `DIVOICE_SECRET`, which keeps working: existing servers change nothing.
- **Deploy to Cloudflare**: the `deploy/` template, which takes code and migrations from this
  package, with Dependabot for updates. When wrangler creates its database (deploying by hand),
  it does so in the EU jurisdiction (wrangler 4.159 or later); the button doesn't (see Unreleased).
  Its deploy script migrates before deploying, except on the very first deploy, when the database
  doesn't exist yet.
- Migration `0003_mail.sql` only adds tables and columns. For diVoice nothing changes: same endpoints,
  same tokens, same invite pages; member and invite lists gain one field each (`apps`, `app`).

## 0.4.0

The organization server as it was in diVoice 0.4.0 (`server/`): AI keys and models, the relay,
members and invites, team dictionary, statistics without text, pilot builds served from KV.
