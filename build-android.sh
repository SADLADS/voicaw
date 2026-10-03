#!/bin/sh
# Build the Android app from this checkout: the client's Android build, cap sync, then the APK
# in Docker (mobile/dist-android.sh). Needs only Docker on the host; the first run builds the
# build image and downloads Gradle's dependencies, which takes a while.
#   ./build-android.sh [--no-push]
# The APK ends up in dist-android/voicaw-debug.apk. Notifications and ringing need
# mobile/android/app/google-services.json (git-ignored, from the Firebase console; README
# "Android app"): without it this stops, unless --no-push asks for an APK without them.
set -e
cd "$(dirname "$0")"
if [ ! -f mobile/android/app/google-services.json ] && [ "$1" != "--no-push" ]; then
  echo "No mobile/android/app/google-services.json in $(pwd): the APK would get no notifications" >&2
  echo "and never ring for calls. Copy it here from the Firebase console (README \"Android app\")," >&2
  echo "or run ./build-android.sh --no-push to build without them." >&2
  exit 1
fi
npm install
npm run dist:android
echo "APK: $(pwd)/dist-android/voicaw-debug.apk"
