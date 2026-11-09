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

## Checked at the first public deploy (9 November 2026)

A test organization deployed with the button, from the public repository and the package on npm:

1. **Dependabot in the copy: yes.** Cloudflare makes the `deploy/` subfolder the root of the new
   repository, `.github/` included: `.github/dependabot.yml` was there, and Dependabot opened its
   first pull request a minute after the repository was created.
2. **The EU jurisdiction: no.** The button creates the database itself, before the build, with no
   jurisdiction (the region it picks is only a location hint), and ignores `"jurisdiction": "eu"`.
   Its form can pick an existing database, so the guide sends European organizations to create the
   database in the EU first ([setup.md](setup.md#where-the-data-lives)).
3. **The lockfile: done** for 0.5.0. Refresh it (`npm install --package-lock-only` in `deploy/`)
   when the template's dependencies change.

Still open: the test server answered Cloudflare's error 1042 during a partial Cloudflare outage, so
the end-to-end check of a deployed server (`/v2/setup`) is to be repeated.
