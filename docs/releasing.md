# Releasing diServer

## Who decides the version

diServer alone. The apps adapt: a diVoice or diMail release that needs something new from the
server says so in its notes ("needs diServer 0.6 or later"), and organizations update their server
first. The apps never set, pin or bump diServer's version, and diServer never follows theirs.

[Semantic versioning](https://semver.org), with the API in [api.md](api.md) as the contract:

| Change | Version |
|---|---|
| Fixes, no change to the API or the schema | patch: 0.5.1 |
| New endpoints or fields, migrations that only add tables and columns | minor: 0.6.0 |
| Removing or changing an endpoint or a field, a migration that isn't additive | major (avoid it) |

Before 1.0.0 the same rules hold; 1.0.0 comes when both apps rely on the API as it is.

## Steps

1. Update [CHANGELOG.md](../CHANGELOG.md): a section for the new version, written for the people who
   run a server.
2. `npm version 0.6.0 --no-git-tag-version`.
3. `npm test`, `npm run typecheck`, `npm run check:template` (packs the package and tries
   `deploy/` with it: types, bundle, migrations on a local database).
4. If the template needs the new version at least, raise the range in `deploy/package.json`
   (e.g. `^0.6.0`); otherwise leave it: Dependabot offers the new version anyway.
5. Commit, tag `v0.6.0`, push.
6. Check what leaves: `gitleaks git . --config .gitleaks.toml` (the whole history) and
   `npm pack --dry-run` (only `src/`, `migrations/`, README, CHANGELOG and LICENSE).
7. Publish: `npm publish` from an npm account with two-factor authentication.
8. A GitHub release for the tag, with the changelog section as notes.

Deployments made from the template get a Dependabot pull request within a week; merging it deploys
the update, migrations first. Servers built by hand update with `npm update diserver && npm run deploy`.

## To verify at the first public deploy

The button needs a public repository and the package on npm, so these are checked only then, with a
test organization:

1. **Dependabot in the copy.** Cloudflare makes the `deploy/` subfolder the root of the new repository.
   One report says the button keeps `.github/dependabot.yml` and drops workflow files (for a template
   at a repository's root); nothing says whether `.github/` inside a subfolder is copied. Check that
   the new repository has `.github/dependabot.yml` and that Dependabot runs there.
   If it doesn't: move the template to its own repository, `tommasoseita/diserver-template`, kept in
   sync from `deploy/` by this repository's CI, and point the button to it. A template at a
   repository's root keeps `dependabot.yml`.
2. **The EU jurisdiction.** Check that the button's database is in the EU (D1 › the database). If
   the button creates the database itself, ignoring `jurisdiction`, the guide must send European
   organizations to create the database first (dashboard: Data location › Specify jurisdiction › EU)
   and put its id in `wrangler.jsonc`.
3. **The lockfile.** Done for 0.5.0: `deploy/package-lock.json` pins what every new deployment
   installs. Refresh it (`npm install --package-lock-only` in `deploy/`) when the template's
   dependencies change.

