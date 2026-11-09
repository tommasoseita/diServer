#!/bin/bash
# Checks deploy/ against this checkout, without publishing anything: packs the package as npm
# would publish it, installs the tarball into a copy of the template, then type-checks, bundles
# and applies the migrations to a local database.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT"
TARBALL="$(npm pack --silent --pack-destination "$WORK")"
echo "packed: $TARBALL ($(tar -tzf "$WORK/$TARBALL" | wc -l | tr -d ' ') files)"
if tar -tzf "$WORK/$TARBALL" | grep -qE '^package/(test|deploy|docs|node_modules)/'; then
  echo "the package contains files it shouldn't" >&2
  exit 1
fi

cp -R "$ROOT/deploy" "$WORK/template"
cd "$WORK/template"
# Until diserver is on npm (and to test unreleased changes), the copy takes it from the tarball.
npm pkg set "dependencies.diserver=file:$WORK/$TARBALL"
npm install --no-audit --no-fund --silent
npx tsc --noEmit
npx wrangler deploy --dry-run --outdir .wrangler/check > /dev/null
npx wrangler d1 migrations apply DB --local > /dev/null
echo "deploy/ works with this version of diserver: types, bundle and migrations"
