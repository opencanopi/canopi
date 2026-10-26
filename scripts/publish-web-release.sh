#!/usr/bin/env bash
# Deploys a published release's root Web Edition archive to Cloudflare Pages with the
# operator's logged-in wrangler (docs/guides/editions.md#web-publishing): verify this release (N),
# locate and verify the previous one (N-1) and merge its files in, so open N-1 tabs keep their
# chunks (2.1-Q83); then, on the preview project canopi-web-preview (web-preview.projectcanopi.com),
# the deploy-skew check (an N-1 tab open while N deploys) and N's checks; then production and its
# checks. Rules and checks live in scripts/web_release.py; the browser checks are desktop/web/e2e-release/.
# Safe to re-run: a production that already serves the release manifest and passes its HTTP checks is
# only checked again; otherwise (say, after a _headers fix) every deploy runs again.
# Test seams: CANOPI_WEB_PRODUCTION_URL, CANOPI_WEB_PREVIEW_URL, CANOPI_WEB_SKEW_TIMEOUT (seconds).

set -Eeuo pipefail

WRANGLER_VERSION="4.107.1"
PRODUCTION_URL="${CANOPI_WEB_PRODUCTION_URL:-https://web.projectcanopi.com}"
PRODUCTION_HOST="web.projectcanopi.com"
# The Pages project behind PRODUCTION_URL.
PRODUCTION_PROJECT="canopi-web"
# A Pages project on a custom domain in the projectcanopi.com zone: *.pages.dev answers no range request.
PREVIEW_PROJECT="canopi-web-preview"
PREVIEW_URL="${CANOPI_WEB_PREVIEW_URL:-https://web-preview.projectcanopi.com}"
SKEW_TIMEOUT="${CANOPI_WEB_SKEW_TIMEOUT:-1200}"

usage() {
  cat <<'EOF'
Usage:
  scripts/publish-web-release.sh --tag vX.Y.Z [options]

Options:
  --tag vX.Y.Z         Published GitHub release to deploy (required)
  --repo OWNER/REPO    GitHub repository (default: opencanopi/canopi)
  --artifact PATH      Use a local canopi-web-edition-root-*.tar.gz instead of downloading it
  --checksums PATH     With --artifact --verify-only: checksums to trust (default: beside the archive);
                       a deploy always verifies against the release's WEB-RELEASE-SHA256SUMS.txt
  --previous-tag vX.Y.Z
                       The release production serves, when it is not the greatest published stable
                       release below this one with a Web archive (open tabs run that release)
  --no-previous        Carry no previous release; refused while production serves a manifest
  --allow-unchanged-pdf-chunk  Run the deploy-skew stage without its lazy-chunk proof when N-1's PDF chunk is N's
  --verify-only        Stop after verifying both archives and merging them
EOF
}

caller_dir="$PWD"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
# The browser checks run in the image whose browsers the locked @playwright/test drives (AF23); the runner in that
# image is the host's desktop/web/node_modules one, so it must be the locked version (checked before any deploy).
playwright_locked="$(python3 -I -c 'import json, sys
print(json.load(open(sys.argv[1]))["packages"]["node_modules/@playwright/test"]["version"])' \
  "$repo_root/desktop/web/package-lock.json")"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v$playwright_locked-noble"
tag=""
repo="opencanopi/canopi"
artifact=""
checksums=""
previous_tag=""
no_previous=0
allow_unchanged_chunk=0
verify_only=0

absolute() {
  if [[ "$1" == /* ]]; then printf '%s\n' "$1"; else printf '%s\n' "$caller_dir/$1"; fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) tag="${2:?--tag requires a value}"; shift 2 ;;
    --repo) repo="${2:?--repo requires a value}"; shift 2 ;;
    --artifact) artifact="$(absolute "${2:?--artifact requires a path}")"; shift 2 ;;
    --checksums) checksums="$(absolute "${2:?--checksums requires a path}")"; shift 2 ;;
    --previous-tag) previous_tag="${2:?--previous-tag requires a value}"; shift 2 ;;
    --no-previous) no_previous=1; shift ;;
    --allow-unchanged-pdf-chunk) allow_unchanged_chunk=1; shift ;;
    --verify-only) verify_only=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ ! "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?)$ ]]; then
  echo "ERROR: --tag must be a release tag such as v2.1.0." >&2
  exit 1
fi
version="${BASH_REMATCH[1]}"
# Only stable releases publish: the next release carries stable N-1s only, and a beta needs its own origin, which
# does not exist yet (ADR 0005, ADR 0029).
if [[ -n "${BASH_REMATCH[2]}" ]]; then
  echo "ERROR: $tag is a pre-release; only stable vX.Y.Z tags publish. A Web beta needs its own origin, which is not built yet (ADR 0029)." >&2
  exit 1
fi

work="$(mktemp -d)"
log_file="$(mktemp "${TMPDIR:-/tmp}/canopi-web-release-${version}.XXXXXX.log")"
# Traces and screenshots of failed browser checks, one directory per run (skew, preview, production); beside the
# log, so they outlive the run.
results="${log_file%.log}-results"
mkdir -p "$results"
# The deploy-skew container, while it runs: stopped on every exit, so none outlives this script or its handoff dir.
skew_container=""
stop_skew() {
  if [[ -n "$skew_container" ]]; then
    docker rm -f "$skew_container" >> "$log_file" 2>&1 || true
    skew_container=""
  fi
}
trap 'stop_skew; rm -rf "$work"' EXIT
# fd 3 keeps the terminal's stderr: the trap runs inside `run`, whose stderr is the log.
exec 3>&2
failed=0
on_error() {
  # A failing command substitution reports once, from the main shell.
  if [[ "$failed" -eq 1 || "$BASH_SUBSHELL" -gt 0 ]]; then return; fi
  failed=1
  echo "[publish-web] FAILED. Last lines of $log_file:" >&3
  tail -n 40 "$log_file" >&3
  if [[ -n "$(ls -A "$results" 2>/dev/null)" ]]; then echo "Browser check results: $results" >&3; fi
}
trap on_error ERR

stage() {
  printf '[publish-web] %s\n' "$*"
  printf '\n== %s\n' "$*" >> "$log_file"
}

run() {
  "$@" >> "$log_file" 2>&1
}

web_release() {
  python3 -I "$repo_root/scripts/web_release.py" "$@"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: Required command '$1' is not installed or not on PATH." >&2
    exit 1
  fi
}

require_cmd python3
printf '[publish-web] Verbose log: %s\n' "$log_file"

commit=""
if [[ -z "$artifact" || "$verify_only" -eq 0 ]]; then
  require_cmd gh
  stage "Reading release $tag in $repo"
  if [[ "$(gh release view "$tag" --repo "$repo" --json isDraft --jq .isDraft)" != "false" ]]; then
    echo "ERROR: $tag is not a published release; publish it before deploying the Web Edition." >&2
    exit 1
  fi
  commit="$(gh api "repos/$repo/commits/$tag" --jq .sha)"
  if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ERROR: Could not resolve $tag to a commit." >&2
    exit 1
  fi
fi

if [[ -z "$artifact" ]]; then
  stage "Downloading the Web Edition archive and WEB-RELEASE-SHA256SUMS.txt"
  mkdir "$work/download"
  archive_name="$(web_release archive-name --version "$version" --commit "$commit")"
  run gh release download "$tag" --repo "$repo" --dir "$work/download" \
    --pattern "$archive_name" --pattern "WEB-RELEASE-SHA256SUMS.txt"
  if [[ ! -f "$work/download/$archive_name" ]]; then
    echo "ERROR: $tag carries no $archive_name, the root Web Edition archive of its commit." >&2
    exit 1
  fi
  artifact="$work/download/$archive_name"
  checksums="$work/download/WEB-RELEASE-SHA256SUMS.txt"
elif [[ "$verify_only" -eq 0 ]]; then
  # A deploy trusts only the published release's checksums, never a file beside a local archive.
  if [[ -n "$checksums" ]]; then
    echo "ERROR: --checksums applies to --verify-only; a deploy verifies against $tag's WEB-RELEASE-SHA256SUMS.txt." >&2
    exit 1
  fi
  stage "Downloading WEB-RELEASE-SHA256SUMS.txt for the local archive"
  mkdir "$work/download"
  run gh release download "$tag" --repo "$repo" --dir "$work/download" --pattern "WEB-RELEASE-SHA256SUMS.txt"
  checksums="$work/download/WEB-RELEASE-SHA256SUMS.txt"
elif [[ -z "$checksums" ]]; then
  checksums="$(dirname "$artifact")/WEB-RELEASE-SHA256SUMS.txt"
fi

stage "Verifying $(basename "$artifact")"
site="$work/site"
commit_args=()
if [[ -n "$commit" ]]; then commit_args=(--commit "$commit"); fi
run web_release verify --archive "$artifact" --checksums "$checksums" --version "$version" \
  "${commit_args[@]}" --output-dir "$site"

require_cmd gh
stage "Locating the previous release (production: $PRODUCTION_URL)"
previous_args=()
if [[ -n "$previous_tag" ]]; then previous_args+=(--previous-tag "$previous_tag"); fi
if [[ "$no_previous" -eq 1 ]]; then previous_args+=(--no-previous); fi
previous_tag="$(web_release previous --version "$version" --repo "$repo" --production-url "$PRODUCTION_URL" \
  "${previous_args[@]}" 2>> "$log_file")"
previous_site=""
if [[ -n "$previous_tag" ]]; then
  previous_version="${previous_tag#v}"
  # N-1's preview deploy names its full commit: the manifest keeps 12 characters, which Pages would pad with zeros.
  previous_commit="$(gh api "repos/$repo/commits/$previous_tag" --jq .sha)"
  previous_archive="$(web_release archive-name --version "$previous_version" --commit "$previous_commit")"
  stage "Downloading $previous_tag's Web Edition archive and WEB-RELEASE-SHA256SUMS.txt"
  mkdir "$work/previous-download"
  run gh release download "$previous_tag" --repo "$repo" --dir "$work/previous-download" \
    --pattern "$previous_archive" --pattern "WEB-RELEASE-SHA256SUMS.txt"
  if [[ ! -f "$work/previous-download/$previous_archive" || ! -f "$work/previous-download/WEB-RELEASE-SHA256SUMS.txt" ]]; then
    echo "ERROR: $previous_tag must carry $previous_archive and WEB-RELEASE-SHA256SUMS.txt." >&2
    exit 1
  fi
  stage "Verifying $previous_archive"
  previous_site="$work/previous"
  run web_release verify-previous --archive "$work/previous-download/$previous_archive" --version "$previous_version" \
    --checksums "$work/previous-download/WEB-RELEASE-SHA256SUMS.txt" --output-dir "$previous_site"
  previous_short="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["commit"])' \
    "$previous_site/canopi-web-edition-manifest.json")"
  if [[ ! "$previous_commit" =~ ^[0-9a-f]{40}$ || "$previous_commit" != "$previous_short"* ]]; then
    echo "ERROR: $previous_tag resolves to ${previous_commit:-nothing}, which is not the commit of its Web archive ($previous_short)." >> "$log_file"
    false
  fi
  stage "Merging $previous_tag's files into $version and adding the deploy files"
  run web_release merge --site "$site" --previous-site "$previous_site"
  # N-1 alone, as the deploy-skew check first serves it.
  run web_release deploy-files --site "$previous_site"
  stage "Checking that $previous_tag loads a PDF chunk $version lacks"
  skew_args=()
  if [[ "$allow_unchanged_chunk" -eq 1 ]]; then skew_args=(--allow-none); fi
  # The chunks the N-1 tab must load after N deploys; empty only with --allow-unchanged-pdf-chunk.
  web_release skew-check --site "$site" --previous-site "$previous_site" "${skew_args[@]}" \
    > "$work/carried-chunks" 2>> "$log_file"
  sed 's/^/carried lazy chunk: /' "$work/carried-chunks" >> "$log_file"
else
  stage "No previous release to carry (--no-previous); adding the deploy files"
  run web_release merge --site "$site"
fi

if [[ "$verify_only" -eq 1 ]]; then
  stage "Verified Web Edition $version; stopping before deploy (--verify-only)"
  exit 0
fi

require_cmd npx
require_cmd docker
playwright_installed="$(python3 -I -c 'import json, sys
try:
    print(json.load(open(sys.argv[1]))["version"])
except (OSError, ValueError, KeyError):
    print("none")' "$repo_root/desktop/web/node_modules/@playwright/test/package.json")"
if [[ "$playwright_installed" != "$playwright_locked" ]]; then
  echo "ERROR: @playwright/test $playwright_installed is installed but $playwright_locked is locked;" \
    "run npm ci --prefix desktop/web." >&2
  exit 1
fi
# Present before any deploy, so no timed wait (the deploy-skew tab's n1-ready) ever includes an image pull; a local
# copy is used as is, so a registry outage does not stop a release.
if ! docker image inspect "$PLAYWRIGHT_IMAGE" > /dev/null 2>&1; then
  stage "Pulling $PLAYWRIGHT_IMAGE"
  run docker pull "$PLAYWRIGHT_IMAGE"
fi

# wrangler_deploy <dir> <project> <branch> <commit>
wrangler_deploy() {
  local dir="$1" project="$2" branch="$3" deploy_commit="$4" output
  output="$(mktemp "$work/wrangler.XXXXXX")"
  mkdir -p "$work/wrangler-cwd"
  (cd "$work/wrangler-cwd" && npx --yes "wrangler@$WRANGLER_VERSION" pages deploy "$dir" \
    --project-name "$project" --branch "$branch" --commit-hash "$deploy_commit") > "$output" 2>&1 || {
    cat "$output" >> "$log_file"
    return 1
  }
  cat "$output" >> "$log_file"
}

# playwright <url> <results name> [handoff dir]: the release smoke, or with a handoff dir the deploy-skew spec alone.
playwright() {
  local url="$1" name="$2" handoff="${3:-}" docker_args=() test_args=()
  if [[ -n "$handoff" ]]; then
    docker_args=(--name "$skew_container" -e CANOPI_WEB_RELEASE_HANDOFF=/handoff -v "$handoff:/handoff")
    test_args=(--project chromium)
  fi
  docker run --rm --ipc=host --user "$(id -u):$(id -g)" -e HOME=/tmp -e NPM_CONFIG_UPDATE_NOTIFIER=false \
    -e CANOPI_WEB_RELEASE_URL="$url" -v "$results:/results" -e CANOPI_WEB_RELEASE_OUTPUT="/results/$name" "${docker_args[@]}" \
    -v "$repo_root/desktop/web:/web:ro" -w /web "$PLAYWRIGHT_IMAGE" \
    npx playwright test --config e2e-release/playwright.config.ts "${test_args[@]}"
}

smoke() {
  run playwright "$1" "$2"
}

# The deploy-skew check (2.1-Q83, Q197): an N-1 tab on the preview's custom domain, open while N deploys,
# loads a lazy chunk absent from N's own files, reads the catalog and keeps saving. The pinned container has
# no wrangler login, so the spec and this host hand off by files: the spec writes n1-ready once its tab is
# open; the host deploys merged N, waits for N's manifest and writes n-deployed.
deploy_skew() {
  local handoff="$work/skew"
  mkdir "$handoff"
  cp "$work/carried-chunks" "$handoff/carried-chunks"
  stage "Deploy skew: deploying $previous_tag to $PREVIEW_PROJECT"
  wrangler_deploy "$previous_site" "$PREVIEW_PROJECT" production "$previous_commit"
  run web_release wait-for --base-url "$PREVIEW_URL" --site "$previous_site" --timeout 600
  stage "Deploy skew: opening a $previous_tag tab on $PREVIEW_URL (Chromium)"
  skew_container="canopi-skew-$$"
  playwright "$PREVIEW_URL" skew "$handoff" >> "$log_file" 2>&1 &
  local skew_pid=$!
  # Every failure stops the container before waiting for its client, so nothing waits past SKEW_TIMEOUT.
  abandon_skew() {
    echo "ERROR: $1" >> "$log_file"
    stop_skew
    kill "$skew_pid" 2>/dev/null || true
    wait "$skew_pid" || true
    return 1
  }
  # await_skew <condition> <message>: poll once a second, up to SKEW_TIMEOUT seconds.
  await_skew() {
    local waited=0
    until eval "$1"; do
      if ! kill -0 "$skew_pid" 2>/dev/null || (( waited >= SKEW_TIMEOUT )); then abandon_skew "$2"; return 1; fi
      sleep 1
      waited=$((waited + 1))
    done
  }
  await_skew '[[ -f "$handoff/n1-ready" ]]' "the deploy-skew tab never reported n1-ready." || return 1
  stage "Deploy skew: deploying merged $version to $PREVIEW_PROJECT while the $previous_tag tab is open"
  wrangler_deploy "$site" "$PREVIEW_PROJECT" production "$commit" || { abandon_skew "the N deploy failed."; return 1; }
  run web_release wait-for --base-url "$PREVIEW_URL" --site "$site" --timeout 600 \
    || { abandon_skew "the preview never served N."; return 1; }
  touch "$handoff/n-deployed"
  stage "Deploy skew: driving the $previous_tag tab after $version deployed"
  await_skew '! kill -0 "$skew_pid" 2>/dev/null' "the deploy-skew tab did not finish within ${SKEW_TIMEOUT} s." || return 1
  skew_container=""
  wait "$skew_pid"
}

if web_release production-current --base-url "$PRODUCTION_URL" --site "$site" >> "$log_file" 2>&1; then
  stage "Production already serves $version and passes its HTTP checks; skipping every deploy"
else
  if [[ -n "$previous_tag" ]]; then
    deploy_skew
  else
    stage "Deploying $version to $PREVIEW_PROJECT"
    wrangler_deploy "$site" "$PREVIEW_PROJECT" production "$commit"
    run web_release wait-for --base-url "$PREVIEW_URL" --site "$site" --timeout 600
  fi
  stage "HTTP checks on $PREVIEW_URL"
  run web_release http-check --base-url "$PREVIEW_URL" --site "$site"
  stage "Browser smoke (Chromium, WebKit) on $PREVIEW_URL"
  smoke "$PREVIEW_URL" preview

  stage "Deploying production"
  run wrangler_deploy "$site" "$PRODUCTION_PROJECT" production "$commit"
  stage "Waiting for $PRODUCTION_URL to serve $version (up to 10 min)"
  run web_release wait-for --base-url "$PRODUCTION_URL" --site "$site" --timeout 600
fi

stage "HTTP and TLS checks on $PRODUCTION_URL"
run web_release http-check --base-url "$PRODUCTION_URL" --site "$site"
run web_release check-tls --host "$PRODUCTION_HOST"
stage "Browser smoke (Chromium, WebKit) on $PRODUCTION_URL"
smoke "$PRODUCTION_URL" production
stage "Web Edition $version is live at $PRODUCTION_URL"
