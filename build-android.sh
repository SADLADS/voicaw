#!/bin/sh
# Release the Android app from this checkout: next version, signed APK, published on the update
# site (updates.voicaw.com/android/) and voicaw.com's Android button.
#   ./build-android.sh [patch|minor|major|X.Y.Z] [-y] [--no-publish] [--no-push]
#   ./build-android.sh --debug [--no-push]
# Default: patch (or, before the first release, mobile/package.json's version). Asks before
# building unless -y. --no-publish only builds dist-android/voicaw-<version>.apk. --debug builds
# dist-android/voicaw-debug.apk (debug key, no version, never published).
#
# Needs only Docker on the host (the first run builds the build image and downloads Gradle's
# dependencies, which takes a while), the release key (mobile/make-release-key.sh, once), and
# for notifications mobile/android/app/google-services.json (git-ignored, from the Firebase
# console; README "Android app"): without it this stops, unless --no-push asks for an APK
# without them. Tracked files aren't touched: the version is stamped into the build.
set -e
cd "$(dirname "$0")"
BUMP=patch
YES=
PUBLISH=1
PUSH=1
DEBUG=
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    --no-publish) PUBLISH= ;;
    --no-push) PUSH= ;;
    --debug) DEBUG=1 ;;
    -*) echo "Unknown option $arg" >&2; exit 1 ;;
    *) BUMP="$arg" ;;
  esac
done

if [ ! -f mobile/android/app/google-services.json ] && [ -n "$PUSH" ]; then
  echo "No mobile/android/app/google-services.json in $(pwd): the APK would get no notifications" >&2
  echo "and never ring for calls. Copy it here from the Firebase console (README \"Android app\")," >&2
  echo "or add --no-push to build without them." >&2
  exit 1
fi

if [ -n "$DEBUG" ]; then
  npm install
  npm run dist:android
  echo "APK: $(pwd)/dist-android/voicaw-debug.apk"
  exit 0
fi

keys="${VOICAW_ANDROID_KEYS:-$HOME/.voicaw-android-keys}"
if [ ! -f "$keys/voicaw-release.jks" ]; then
  echo "No release key in $keys. Make it once with mobile/make-release-key.sh and back it up;" >&2
  echo "copy the same folder to any other machine that builds releases." >&2
  exit 1
fi

VERSION="$(node updates/publish-android.mjs next "$BUMP")"
echo "Android app $VERSION, from $(git rev-parse --abbrev-ref HEAD) $(git rev-parse --short HEAD)$([ -n "$PUBLISH" ] && echo ", published to the update site")."
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Note: this checkout has uncommitted changes; they'll be in the build."
fi
if [ -z "$YES" ]; then
  printf "Build%s %s? [y/N] " "$([ -n "$PUBLISH" ] && echo " and publish")" "$VERSION"
  read -r answer
  case "$answer" in y|Y|yes) ;; *) echo "Cancelled."; exit 1 ;; esac
fi

npm install
npm run build:android --workspace=client
(cd mobile && npx cap sync android)
VOICAW_VERSION="$VERSION" sh mobile/dist-android.sh release
apk="$(pwd)/dist-android/voicaw-$VERSION.apk"
if [ -n "$PUBLISH" ]; then
  node updates/publish-android.mjs publish "$apk" "$VERSION"
  echo "Download: https://updates.voicaw.com/android/voicaw.apk"
else
  echo "APK: $apk"
fi
