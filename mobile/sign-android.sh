#!/bin/sh
# Signs an unsigned Android release (GitHub's build, `mobile/dist-android.sh unsigned`) with the
# release key, on this machine: the key never goes to GitHub. release_all.sh runs it after
# checking the files' attestations.
#   mobile/sign-android.sh <unsigned.apk> <unsigned-play.aab> <version>
# Makes dist-android/voicaw-<version>.apk (apksigner, v2/v3 signatures only, as minSdk is 26, and
# the entries kept exactly as built, so anyone can check the signed APK is GitHub's build plus
# our signature, with apksigcopier compare) and dist-android/voicaw-<version>-play.aab
# (jarsigner, as Play wants bundles signed with the upload key: ours). Both files must be inside
# this checkout (Docker mounts it). Uses the voicaw-android-build image (mobile/Dockerfile).
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
keys="${VOICAW_ANDROID_KEYS:-$HOME/.voicaw-android-keys}"
if [ $# -ne 3 ]; then echo "usage: $0 <unsigned.apk> <unsigned-play.aab> <version>" >&2; exit 1; fi
version="$3"
if [ ! -f "$keys/voicaw-release.jks" ] || [ ! -f "$keys/password" ]; then
  echo "No release key in $keys: make it once with mobile/make-release-key.sh (and back it up)." >&2
  exit 1
fi
# inside FILE: FILE's path from the checkout's root (it must be in the checkout).
inside() {
  file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
  case "$file" in
    "$root"/*) echo "${file#"$root"/}" ;;
    *) echo "$1 isn't inside $root" >&2; return 1 ;;
  esac
}
apk_in="$(inside "$1")"
aab_in="$(inside "$2")"

if ! docker image inspect voicaw-android-build > /dev/null 2>&1; then
  docker build -t voicaw-android-build "$root/mobile"
fi
mkdir -p "$root/dist-android"
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp/home \
    -v "$root":/project -v "$keys":/keys:ro -w /project voicaw-android-build \
    sh -c '
      set -e
      tools="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -n 1)"
      # Gradle aligns it already. Not realigned (zipalign or apksigner would rewrite the entries,
      # and then the signed APK would no longer be the attested build plus a signature).
      if ! "$tools/zipalign" -c -p 4 "$1" > /dev/null; then echo "$1 isn'"'"'t zipaligned" >&2; exit 1; fi
      # No --key-pass: the key has the keystore password, which apksigner then tries (given the
      # same file twice, it reads the file'"'"'s next line for the second).
      "$tools/apksigner" sign --ks /keys/voicaw-release.jks --ks-type PKCS12 --ks-key-alias voicaw \
          --ks-pass file:/keys/password --alignment-preserved true \
          --v1-signing-enabled false --v4-signing-enabled false --out "$3" "$1"
      "$tools/apksigner" verify "$3"
      cp "$2" "$4.tmp"
      jarsigner -keystore /keys/voicaw-release.jks -storetype PKCS12 -storepass:file /keys/password \
          -sigalg SHA256withRSA -digestalg SHA-256 "$4.tmp" voicaw > /dev/null
      jarsigner -verify "$4.tmp" > /dev/null
      mv "$4.tmp" "$4"
    ' sh "$apk_in" "$aab_in" "dist-android/voicaw-$version.apk" "dist-android/voicaw-$version-play.aab"
echo "Signed $root/dist-android/voicaw-$version.apk and voicaw-$version-play.aab"
