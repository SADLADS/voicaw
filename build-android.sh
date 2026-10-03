#!/bin/sh
# Build the Android app from this checkout: the client's Android build, cap sync, then the APK
# in Docker (mobile/dist-android.sh). Needs only Docker on the host; the first run builds the
# build image and downloads Gradle's dependencies, which takes a while.
#   ./build-android.sh
# The APK ends up in dist-android/voicaw-debug.apk. Notifications while the app is closed need
# mobile/android/app/google-services.json (git-ignored, from the Firebase console; README
# "Android app").
set -e
cd "$(dirname "$0")"
if [ ! -f mobile/android/app/google-services.json ]; then
  echo "Warning: no mobile/android/app/google-services.json, so this APK can't get notifications" >&2
  echo "or ring for calls while it's closed (README \"Android app\")." >&2
fi
npm install
npm run dist:android
echo "APK: $(pwd)/dist-android/voicaw-debug.apk"
