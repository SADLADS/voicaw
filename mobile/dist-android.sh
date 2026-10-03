#!/bin/sh
# Builds the Android app (`npm run dist:android` from the repo root, after the client build and
# `cap sync`): Gradle in the voicaw-android-build image (mobile/Dockerfile, built here the first
# time), so the host needs only Docker. Runs as you, so nothing is left owned by root; Gradle's
# downloads are kept in ~/.gradle. The APK is a debug build (signed with a debug key made on the
# first build, in ~/.android), copied to dist-android/.
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
if ! docker image inspect voicaw-android-build > /dev/null 2>&1; then
  docker build -t voicaw-android-build "$root/mobile"
fi
mkdir -p "$HOME/.gradle" "$HOME/.android" "$root/dist-android"
docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp/home \
    -e GRADLE_USER_HOME=/cache/gradle \
    -e ANDROID_USER_HOME=/cache/android \
    -v "$root":/project \
    -v "$HOME/.gradle":/cache/gradle \
    -v "$HOME/.android":/cache/android \
    -w /project/mobile/android \
    voicaw-android-build \
    sh -c 'mkdir -p "$HOME" && ./gradlew --no-daemon testDebugUnitTest assembleDebug'
cp "$root/mobile/android/app/build/outputs/apk/debug/app-debug.apk" "$root/dist-android/voicaw-debug.apk"
echo "Built dist-android/voicaw-debug.apk"
