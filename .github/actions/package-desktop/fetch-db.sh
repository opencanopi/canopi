#!/usr/bin/env bash
# The bundled plant DB for a desktop package (package-desktop, design check AR4): the prepared asset the species catalog
# contract names, downloaded from the DB release, held to the Release Candidate preflight's sha256 when one is given,
# verified against the contract and only then put where `tauri build` bundles it. Any refusal exits non-zero before the
# DB reaches desktop/resources, so a job never builds with a DB it did not verify.
#
#   .github/actions/package-desktop/fetch-db.sh <release tag> [<sha256>]
#
# Run from the repository root; the hash is node's, the one tool every runner has the same way.
set -euo pipefail

tag=$1
expected=${2:-}
asset="$(python3 scripts/species_catalog_contract.py value prepared-db-asset-name)"
download="$(mktemp -d)"
trap 'rm -rf "$download"' EXIT
gh release download "$tag" --repo "$GITHUB_REPOSITORY" --pattern "$asset" --dir "$download"
db="$download/$asset"
if [[ ! -s "$db" ]]; then
  echo "::error::Bundled DB asset '$asset' from '$tag' was not downloaded or is empty." >&2
  exit 1
fi
if [[ -n "$expected" ]]; then
  actual="$(DB_PATH="$db" node -e '
    const hash = require("node:crypto").createHash("sha256")
    require("node:fs").createReadStream(process.env.DB_PATH).on("data", (chunk) => hash.update(chunk))
      .on("error", (error) => { console.error(error); process.exit(1) }).on("end", () => process.stdout.write(hash.digest("hex")))')"
  if [[ "$actual" != "$expected" ]]; then
    echo "::error::Bundled DB checksum changed after preflight: expected $expected, found $actual." >&2
    exit 1
  fi
  echo "Bundled DB checksum matches preflight: $actual"
fi
python3 scripts/species_catalog_contract.py verify-db --profile prepared "$db"
mkdir -p desktop/resources
mv "$db" desktop/resources/canopi-core.db
