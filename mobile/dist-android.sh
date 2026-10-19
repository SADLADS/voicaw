#!/bin/sh
# Builds the Android app (after the client build and `cap sync`; build-android.sh at the root
# does it all): Gradle in the voicaw-android-build image (mobile/Dockerfile, built here the first
# time), so the host needs only Docker. Runs as you, so nothing is left owned by root; Gradle's
# downloads are kept in ~/.gradle. Two flavours: `direct` (the APK we host, which updates itself)
# and `play` (for Google Play, without the updater; compiled even in a debug build, to keep it
# building).
#   mobile/dist-android.sh            debug APK, signed with a debug key made on the first build
#                                     (in ~/.android): dist-android/voicaw-debug.apk
#   mobile/dist-android.sh release    version VOICAW_VERSION, signed with the key from
#                                     mobile/make-release-key.sh (VOICAW_ANDROID_KEYS, default
#                                     ~/.voicaw-android-keys): the direct APK,
#                                     dist-android/voicaw-<version>.apk, and the play App Bundle
#                                     to upload to the Play Console, dist-android/voicaw-<version>-play.aab
#   mobile/dist-android.sh unsigned   the same two, unsigned (no key needed):
#                                     dist-android/voicaw-<version>-unsigned.apk and
#                                     voicaw-<version>-play-unsigned.aab. GitHub's release build
#                                     (.github/workflows/desktop-release.yml); release_all.sh
#                                     signs them on the host (mobile/sign-android.sh).
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-debug}"
keys="${VOICAW_ANDROID_KEYS:-$HOME/.voicaw-android-keys}"
case "$mode" in
  debug) task=assembleDirectDebug ;;
  release)
    task="assembleDirectRelease bundlePlayRelease"
    if [ -z "$VOICAW_VERSION" ]; then echo "VOICAW_VERSION isn't set." >&2; exit 1; fi
    if [ ! -f "$keys/voicaw-release.jks" ] || [ ! -f "$keys/password" ]; then
      echo "No release key in $keys: make it once with mobile/make-release-key.sh (and back it up)." >&2
      exit 1
    fi
    ;;
  unsigned)
    task="assembleDirectRelease bundlePlayRelease"
    if [ -z "$VOICAW_VERSION" ]; then echo "VOICAW_VERSION isn't set." >&2; exit 1; fi
    ;;
  *) echo "usage: $0 [debug|release|unsigned]" >&2; exit 1 ;;
esac
version="${VOICAW_VERSION:-$(node -p "require('$root/mobile/package.json').version")}"

# The user agent says which version this is (Settings → Devices): stamped into the config
# `cap sync` copied into the app, not the tracked capacitor.config.json.
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.android = { ...config.android, appendUserAgent: `VoicawAndroid/${process.argv[2]}` };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
' "$root/mobile/android/app/src/main/assets/capacitor.config.json" "$version"

if ! docker image inspect voicaw-android-build > /dev/null 2>&1; then
  docker build -t voicaw-android-build "$root/mobile"
fi
mkdir -p "$HOME/.gradle" "$HOME/.android" "$root/dist-android"
set -- \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp/home \
    -e GRADLE_USER_HOME=/cache/gradle \
    -e ANDROID_USER_HOME=/cache/android \
    -e VOICAW_VERSION="$version" \
    -e VOICAW_UNSIGNED="$([ "$mode" = unsigned ] && echo 1)" \
    -v "$root":/project \
    -v "$HOME/.gradle":/cache/gradle \
    -v "$HOME/.android":/cache/android
if [ "$mode" = release ]; then
  # The key folder, read-only; the password is read inside, never on a command line.
  set -- "$@" -v "$keys":/keys:ro -e VOICAW_KEYSTORE=/keys/voicaw-release.jks
fi
docker run --rm "$@" -w /project/mobile/android voicaw-android-build \
    sh -c '
      mkdir -p "$HOME"
      if [ -f /keys/password ]; then export VOICAW_KEYSTORE_PASSWORD="$(cat /keys/password)"; fi
      ./gradlew --no-daemon testDirectDebugUnitTest compilePlayDebugJavaWithJavac '"$task"

if [ "$mode" = release ]; then
  apk="$root/dist-android/voicaw-$version.apk"
  cp "$root/mobile/android/app/build/outputs/apk/direct/release/app-direct-release.apk" "$apk"
  cp "$root/mobile/android/app/build/outputs/bundle/playRelease/app-play-release.aab" "$root/dist-android/voicaw-$version-play.aab"
  echo "Built $root/dist-android/voicaw-$version-play.aab"
elif [ "$mode" = unsigned ]; then
  apk="$root/dist-android/voicaw-$version-unsigned.apk"
  cp "$root/mobile/android/app/build/outputs/apk/direct/release/app-direct-release-unsigned.apk" "$apk"
  cp "$root/mobile/android/app/build/outputs/bundle/playRelease/app-play-release.aab" "$root/dist-android/voicaw-$version-play-unsigned.aab"
  echo "Built $root/dist-android/voicaw-$version-play-unsigned.aab"
else
  apk="$root/dist-android/voicaw-debug.apk"
  cp "$root/mobile/android/app/build/outputs/apk/direct/debug/app-direct-debug.apk" "$apk"
fi
echo "Built $apk"
