#!/bin/sh
# Release everything from this checkout's commit: the desktop app (Linux and Windows) and the
# Android app, built by GitHub, and the web app (app.voicaw.com), all as one version:
#   ./release_all.sh [patch|minor|major|X.Y.Z] [--no-publish] [--no-web] [--no-android] [--no-play]
#
# 1. Picks the next version (default: patch above what updates.voicaw.com has for desktop or
#    Android, or the newest desktop-v* tag if that's higher). It doesn't ask: running it is the
#    go-ahead (-y and the old --android are still accepted, and do nothing).
# 2. Tags the commit as desktop-vX.Y.Z and pushes the tag. That starts
#    .github/workflows/desktop-release.yml, which builds the installers and the Android app
#    (unsigned) on GitHub's machines, attests every file (Sigstore) and puts them in a GitHub
#    Release. Given the version of a tag
#    already pushed but never published (its build failed and was re-run, or the publish
#    stopped), it finishes that release from the tag's commit, whatever is checked out.
# 3. Waits for it, downloads the release into dist-release/X.Y.Z/, and checks every file's
#    attestation with the GitHub CLI: built by that workflow, from this commit, on GitHub's own
#    machines. Nothing unverified is published.
# 4. Publishes them to the update site (updates/publish.mjs: /opt/voicaw-updates, and voicaw.com's
#    download links), then checks the site serves the new version. --no-publish stops after 3.
# 5. The web app: `npm run build` (built here, put live at /opt/voicaw-client only if the build
#    succeeded). Not with --no-publish or --no-web.
# 6. The Android app, the same version: GitHub's unsigned APK and App Bundle (checked in 3) are
#    signed here with the release key (mobile/sign-android.sh, into dist-android/; the key never
#    goes to GitHub). Then the APK is published for copies installed from the update site
#    (unless it already is) and added to the GitHub Release, the bundle goes to Google Play
#    (updates/publish-play.mjs: the closed-testing track, VOICAW_PLAY_TRACK for another; skipped
#    with a note while there's no Play key, or with --no-play), and the android-vX.Y.Z tag is
#    pushed beside the desktop one. --no-publish only signs them; --no-android skips it all
#    (Android then has a gap in its versions, never a clash). A release tagged before GitHub
#    built Android has no Android files: it's built here instead (./build-android.sh X.Y.Z).
#
# Needs: the commit pushed to GitHub, no uncommitted changes, the GitHub CLI logged in
# (`gh auth login`; installing it: README "Desktop app"), and for Android the release key, the
# repository secret GOOGLE_SERVICES_JSON and, for Play, its service account key (README
# "Android app"), checked before anything starts.
# VOICAW_UPDATES_DIR publishes somewhere else (a try-out: the web app isn't deployed then, unless
# VOICAW_WEB_ROOT says where), VOICAW_REPO names another GitHub repository (default
# SADLADS/voicaw).
set -e
cd "$(dirname "$0")"

REPO="${VOICAW_REPO:-SADLADS/voicaw}"
WORKFLOW=desktop-release.yml
SITE="${VOICAW_UPDATES_DIR:-/opt/voicaw-updates}"
PUBLIC_URL="https://updates.voicaw.com/desktop"
API="https://api.github.com/repos/$REPO"

BUMP=patch
PUBLISH=1
WEB=1
ANDROID=1
PLAY=1
for arg in "$@"; do
  case "$arg" in
    -y|--yes|--android) ;;
    --no-publish) PUBLISH= ;;
    --no-web) WEB= ;;
    --no-android) ANDROID= ;;
    --no-play) PLAY= ;;
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
# What Android needs, checked now rather than after desktop and web are out.
if [ -n "$ANDROID" ]; then
  if [ ! -f "${VOICAW_ANDROID_KEYS:-$HOME/.voicaw-android-keys}/voicaw-release.jks" ]; then
    echo "No Android release key (mobile/make-release-key.sh, README \"Android app\"). --no-android skips it." >&2
    exit 1
  fi
  # Only an admin can list secrets: if this login can't, GitHub's build says so instead.
  if secrets="$(gh secret list --repo "$REPO" 2>/dev/null)" && ! printf '%s\n' "$secrets" | grep -q '^GOOGLE_SERVICES_JSON\b'; then
    echo "GitHub has no GOOGLE_SERVICES_JSON secret, which its Android build needs:" >&2
    echo "  gh secret set GOOGLE_SERVICES_JSON --repo $REPO < mobile/android/app/google-services.json" >&2
    echo "(README \"Android app\"). --no-android skips Android." >&2
    exit 1
  fi
  if [ -n "$PLAY" ] && [ ! -f "$(node -e 'import("./updates/publish-play.mjs").then((m) => console.log(m.keyPath()))')" ]; then
    echo "Note: no Google Play service account key (README \"Android app\"), so the App Bundle won't be uploaded to Play."
    PLAY=
  fi
fi
COMMIT="$(git rev-parse HEAD)"
git fetch -q origin
if [ -z "$(git branch -r --contains "$COMMIT" | grep '^ *origin/')" ]; then
  echo "$(git rev-parse --short HEAD) isn't on GitHub yet: push its branch first." >&2
  exit 1
fi

# The version: above what's published (desktop and Android: they share version numbers) and
# every desktop-v* tag.
VERSION="$(node -e '
  const [want, releasesFile, androidFile, tags, android] = process.argv.slice(1);
  const n = (s) => s.split(".").map(Number);
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  // The version of a tag already pushed may be asked for again, published or not: finishing a
  // release that stopped, or retrying a step that failed (every step is safe to repeat).
  const tagged = tags.split(/\s+/).includes(`desktop-v${want}`);
  let current = [0, 0, 0];
  try {
    for (const p of Object.values(require(releasesFile).platforms || {})) {
      if (p.version && !(tagged && p.version === want) && cmp(n(p.version), current) > 0) current = n(p.version);
    }
  } catch {}
  try {
    const v = require(androidFile).android?.version;
    if (v && !(tagged && v === want) && cmp(n(v), current) > 0) current = n(v);
  } catch {}
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
  // The Android versionCode is X·10000 + Y·100 + Z (updates/publish-android.mjs).
  if (android && (next[1] > 99 || next[2] > 99)) { console.error(`${next.join(".")}: minor and patch must stay under 100 for Android`); process.exit(1); }
  console.log(next.join("."));
' "$BUMP" "$SITE/desktop/releases.json" "$SITE/android/releases.json" "$(git ls-remote --tags origin 'desktop-v*' | sed 's|.*refs/tags/||; s|\^{}$||' | sort -u)" "$ANDROID")"
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
# GitHub turns spaces in a release's file names into dots ("Voicaw Setup 1.2.3.exe" comes back
# as "Voicaw.Setup.1.2.3.exe"), but the update feeds name the originals: give the files those
# names back, and their blockmaps (which the apps fetch next to them). Attestations go by
# content, so they still check out.
for feed in "$OUT"/latest*.yml; do
  sed -n "s/^ *- url: *//p; s/^path: *//p" "$feed" | tr -d "'\"" | sort -u
done | while IFS= read -r name; do
  for file in "$name" "$name.blockmap"; do
    github_name="$(printf '%s' "$file" | tr ' ' '.')"
    if [ ! -e "$OUT/$file" ] && [ -e "$OUT/$github_name" ]; then mv "$OUT/$github_name" "$OUT/$file"; fi
  done
done

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
# The Android files apart (updates/publish.mjs publishes whatever else is in $OUT).
ANDROID_OUT="$OUT/android"
mkdir -p "$ANDROID_OUT"
for file in "$OUT"/*.apk "$OUT"/*.aab; do
  [ -e "$file" ] && mv "$file" "$ANDROID_OUT/"
done
if [ -n "$ANDROID" ] && [ -f "$ANDROID_OUT/voicaw-$VERSION-unsigned.apk" ]; then
  mobile/sign-android.sh "$ANDROID_OUT/voicaw-$VERSION-unsigned.apk" "$ANDROID_OUT/voicaw-$VERSION-play-unsigned.aab" "$VERSION"
fi

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

if [ -n "$WEB" ]; then
  echo "== Web app"
  if [ -z "$PUBLISH" ]; then
    echo "Not deployed (--no-publish)."
  elif [ -n "$VOICAW_UPDATES_DIR" ] && [ -z "$VOICAW_WEB_ROOT" ]; then
    echo "Not deployed (a try-out: set VOICAW_WEB_ROOT to deploy it somewhere)."
  else
    npm install
    npm run build
  fi
fi

FAILED=
if [ -n "$ANDROID" ]; then
  echo "== Android $VERSION"
  APK="dist-android/voicaw-$VERSION.apk"
  AAB="dist-android/voicaw-$VERSION-play.aab"
  published="$(node -e 'try { console.log(require(process.argv[1]).android?.version ?? "") } catch {}' "$SITE/android/releases.json")"
  if [ ! -f "$ANDROID_OUT/voicaw-$VERSION-unsigned.apk" ]; then
    # Tagged before GitHub built Android: built here, the old way (not added to GitHub's release,
    # since GitHub didn't build it).
    echo "GitHub's release has no Android build (tagged before it made one): building it here."
    if [ "$published" = "$VERSION" ]; then
      echo "Android $VERSION is already published."
    else
      NO_PUBLISH=
      [ -z "$PUBLISH" ] && NO_PUBLISH=--no-publish
      ./build-android.sh "$VERSION" $NO_PUBLISH --push-tag
    fi
    if [ -n "$PUBLISH" ] && [ -n "$PLAY" ] && [ -f "$AAB" ]; then
      node updates/publish-play.mjs "$AAB" "$VERSION" || FAILED=", the Google Play upload"
    fi
  elif [ -z "$PUBLISH" ]; then
    echo "Signed, not published (--no-publish): $APK, $AAB"
  else
    if [ "$published" = "$VERSION" ]; then echo "Android $VERSION is already on the update site."
    else node updates/publish-android.mjs publish "$APK" "$VERSION"; fi
    if gh release upload "$TAG" "$APK" --repo "$REPO" --clobber; then echo "Added $(basename "$APK") to GitHub's release."
    else FAILED="$FAILED, adding the APK to GitHub's release"; fi
    if [ -n "$PLAY" ]; then
      node updates/publish-play.mjs "$AAB" "$VERSION" || FAILED="$FAILED, the Google Play upload"
    else
      echo "For Google Play: upload $(pwd)/$AAB in the Play Console."
    fi
    ANDROID_TAG="android-v$VERSION"
    if ! git rev-parse -q --verify "refs/tags/$ANDROID_TAG" >/dev/null; then
      git tag -a "$ANDROID_TAG" "$COMMIT" -m "Android app $VERSION"
    fi
    if git push -q origin "refs/tags/$ANDROID_TAG"; then echo "Pushed $ANDROID_TAG."
    else FAILED="$FAILED, pushing $ANDROID_TAG"; fi
  fi
fi

if [ -n "$FAILED" ]; then
  echo "Everything else is out, but these failed (above): ${FAILED#, }. ./release_all.sh $VERSION runs the release again, retrying them." >&2
  exit 1
fi
