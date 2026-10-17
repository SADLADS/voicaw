#!/bin/sh
# Release the desktop app (Linux and Windows), built by GitHub from this checkout's commit:
#   ./release_all.sh [patch|minor|major|X.Y.Z] [-y] [--no-publish] [--android]
#
# 1. Picks the next version (default: patch above what updates.voicaw.com has, or the newest
#    desktop-v* tag if that's higher) and asks (unless -y).
# 2. Tags the commit as desktop-vX.Y.Z and pushes the tag. That starts
#    .github/workflows/desktop-release.yml, which builds the installers on GitHub's machines,
#    attests every file (Sigstore) and puts them in a GitHub Release. Given the version of a tag
#    already pushed but never published (its build failed and was re-run, or the publish
#    stopped), it finishes that release from the tag's commit, whatever is checked out.
# 3. Waits for it, downloads the release into dist-release/X.Y.Z/, and checks every file's
#    attestation with the GitHub CLI: built by that workflow, from this commit, on GitHub's own
#    machines. Nothing unverified is published.
# 4. Publishes them to the update site (updates/publish.mjs: /opt/voicaw-updates, and voicaw.com's
#    download links), then checks the site serves the new version. --no-publish stops after 3.
# --android then releases the Android app the usual way (./build-android.sh, same bump; its
# versions are its own).
#
# Needs: the commit pushed to GitHub, no uncommitted changes, and the GitHub CLI logged in
# (`gh auth login`; installing it: README "Desktop app"). VOICAW_UPDATES_DIR publishes somewhere
# else (a try-out), VOICAW_REPO names another GitHub repository (default SADLADS/voicaw).
set -e
cd "$(dirname "$0")"

REPO="${VOICAW_REPO:-SADLADS/voicaw}"
WORKFLOW=desktop-release.yml
SITE="${VOICAW_UPDATES_DIR:-/opt/voicaw-updates}"
PUBLIC_URL="https://updates.voicaw.com/desktop"
API="https://api.github.com/repos/$REPO"

BUMP=patch
YES=
PUBLISH=1
ANDROID=
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    --no-publish) PUBLISH= ;;
    --android) ANDROID=1 ;;
    -*) echo "Unknown option $arg" >&2; exit 1 ;;
    *) BUMP="$arg" ;;
  esac
done

# github PATH: GitHub's API (with the CLI's login when there is one: more requests an hour).
github() {
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh api "repos/$REPO/$1"
  else
    curl -fsSL -H 'Accept: application/vnd.github+json' "$API/$1"
  fi
}

# json EXPRESSION: evaluates EXPRESSION on the JSON read from stdin (as `d`).
json() {
  node -e 'let s = ""; process.stdin.on("data", (c) => { s += c; }).on("end", () => {
    const d = JSON.parse(s); const r = eval(process.argv[1]); if (r !== undefined && r !== null) console.log(r); });' "$1"
}

if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  echo "The GitHub CLI isn't installed or logged in (gh auth login): it checks the builds' attestations." >&2
  exit 1
fi
if ! gh attestation verify --help >/dev/null 2>&1; then
  echo "This GitHub CLI ($(gh --version | head -1)) can't check attestations: it needs 2.49 or later." >&2
  echo "Debian's package is older; install GitHub's own (README \"Desktop app\")." >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "This checkout has uncommitted changes: commit them (and push) first, GitHub builds the commit." >&2
  exit 1
fi
COMMIT="$(git rev-parse HEAD)"
git fetch -q origin
if [ -z "$(git branch -r --contains "$COMMIT" | grep '^ *origin/')" ]; then
  echo "$(git rev-parse --short HEAD) isn't on GitHub yet: push its branch first." >&2
  exit 1
fi

# The version: above both what's published and every desktop-v* tag.
VERSION="$(node -e '
  const [want, releasesFile, tags] = process.argv.slice(1);
  const n = (s) => s.split(".").map(Number);
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  let current = [0, 0, 0];
  try {
    for (const p of Object.values(require(releasesFile).platforms || {})) {
      if (p.version && cmp(n(p.version), current) > 0) current = n(p.version);
    }
  } catch {}
  // An explicit version may be an unpublished tag already pushed (a release whose build failed
  // and was re-run): the tag must then be on this commit (checked below).
  for (const tag of tags.split(/\s+/)) {
    const m = /^desktop-v(\d+\.\d+\.\d+)$/.exec(tag);
    if (m && m[1] !== want && cmp(n(m[1]), current) > 0) current = n(m[1]);
  }
  const [a, b, c] = current;
  let next;
  if (want === "patch") next = [a, b, c + 1];
  else if (want === "minor") next = [a, b + 1, 0];
  else if (want === "major") next = [a + 1, 0, 0];
  else if (/^\d+\.\d+\.\d+$/.test(want)) next = n(want);
  else { console.error(`Not a version: ${want} (patch, minor, major or X.Y.Z)`); process.exit(1); }
  if (cmp(next, current) <= 0) { console.error(`${next.join(".")} is not higher than ${current.join(".")}`); process.exit(1); }
  console.log(next.join("."));
' "$BUMP" "$SITE/desktop/releases.json" "$(git ls-remote --tags origin 'desktop-v*' | sed 's|.*refs/tags/||; s|\^{}$||' | sort -u)")"
TAG="desktop-v$VERSION"

# A tag that's already there (pushed but not published: the version check let it through) is a
# release to finish, from its own commit, whatever is checked out now.
git fetch -q origin "refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null || true
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  COMMIT="$(git rev-parse "$TAG^{commit}")"
  NEW_TAG=
  echo "Desktop $VERSION: finishing $TAG, on $(git rev-parse --short "$COMMIT"), built by GitHub ($REPO)."
else
  NEW_TAG=1
  echo "Desktop $VERSION from $(git rev-parse --abbrev-ref HEAD) $(git rev-parse --short HEAD), built by GitHub ($REPO)."
fi
[ -n "$PUBLISH" ] && echo "Then published to $SITE."
if [ -z "$YES" ]; then
  if [ -n "$NEW_TAG" ]; then printf "Tag %s, push the tag and release? [y/N] " "$TAG"
  else printf "Finish releasing %s? [y/N] " "$TAG"; fi
  read -r answer
  case "$answer" in y|Y|yes) ;; *) echo "Cancelled."; exit 1 ;; esac
fi

# 2. The tag starts the build.
[ -n "$NEW_TAG" ] && git tag -a "$TAG" "$COMMIT" -m "Desktop app $VERSION"
git push -q origin "refs/tags/$TAG"
echo "Pushed $TAG. Waiting for GitHub's build…"

# 3. Wait for the workflow run of that tag.
RUN=
for _ in $(seq 1 60); do
  RUN="$(github "actions/workflows/$WORKFLOW/runs?event=push&branch=$TAG&per_page=1" \
    | json 'd.workflow_runs[0] && [d.workflow_runs[0].id, d.workflow_runs[0].html_url].join(" ")')" || true
  [ -n "$RUN" ] && break
  sleep 5
done
if [ -z "$RUN" ]; then echo "No workflow run started for $TAG (is $WORKFLOW on GitHub?)." >&2; exit 1; fi
RUN_ID="${RUN%% *}"
echo "Building: ${RUN#* }"
while :; do
  STATE="$(github "actions/runs/$RUN_ID" | json '[d.status, d.conclusion].join(" ")')" || STATE="unknown"
  case "$STATE" in
    "completed success") break ;;
    completed*) echo "The build ended: ${STATE#completed }. See ${RUN#* }" >&2; exit 1 ;;
  esac
  sleep 30
done
echo "Built."

OUT="dist-release/$VERSION"
rm -rf "$OUT"
mkdir -p "$OUT"
github "releases/tags/$TAG" | json 'd.assets.map((a) => a.name + " " + a.browser_download_url).join("\n")' \
  | while read -r name url; do
      case "$name" in */*|.*|"") echo "Odd file name in the release: $name" >&2; exit 1 ;; esac
      curl -fsSL -o "$OUT/$name" "$url"
    done
COUNT="$(ls "$OUT" | wc -l)"
if [ "$COUNT" -eq 0 ]; then echo "The release has no files." >&2; exit 1; fi

echo "Checking $COUNT files' attestations…"
for file in "$OUT"/*; do
  if ! gh attestation verify "$file" --repo "$REPO" \
      --signer-workflow "$REPO/.github/workflows/$WORKFLOW" \
      --source-ref "refs/tags/$TAG" --source-digest "$COMMIT" \
      --deny-self-hosted-runners >/dev/null; then
    echo "$(basename "$file"): its attestation doesn't check out. Not publishing." >&2
    exit 1
  fi
done
for feed in "$OUT"/latest*.yml; do
  built="$(sed -n 's/^version: *//p' "$feed")"
  if [ "$built" != "$VERSION" ]; then echo "$feed says $built, not $VERSION" >&2; exit 1; fi
done
echo "Every file was built by $WORKFLOW from $(git rev-parse --short "$COMMIT")."

# 4. Publish.
if [ -z "$PUBLISH" ]; then
  echo "Not published (--no-publish): $OUT"
else
  node updates/publish.mjs "$OUT" "$SITE"
  if [ -z "$VOICAW_UPDATES_DIR" ]; then
    served="$(curl -fsSL "$PUBLIC_URL/latest-linux.yml?$(date +%s)" | sed -n 's/^version: *//p')" || served=
    if [ "$served" = "$VERSION" ]; then echo "updates.voicaw.com serves $VERSION."
    else echo "Warning: updates.voicaw.com serves ${served:-nothing} for Linux, not $VERSION." >&2; fi
  fi
fi

if [ -n "$ANDROID" ]; then
  echo "== Android"
  # Its versions are its own: an explicit desktop version means its next patch.
  case "$BUMP" in patch|minor|major) ANDROID_BUMP="$BUMP" ;; *) ANDROID_BUMP=patch ;; esac
  NO_PUBLISH=
  [ -z "$PUBLISH" ] && NO_PUBLISH=--no-publish
  ./build-android.sh "$ANDROID_BUMP" ${YES:+-y} $NO_PUBLISH
fi
