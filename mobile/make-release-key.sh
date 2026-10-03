#!/bin/sh
# Makes the Android app's release signing key, once per project (not per machine): every APK
# must be signed with the same key, or phones refuse it as an update. Back the folder up
# somewhere safe (a password manager, an encrypted drive); a new key means everyone reinstalls.
#   mobile/make-release-key.sh [folder]
# Default folder: ~/.voicaw-android-keys (or VOICAW_ANDROID_KEYS), outside git. It gets
# voicaw-release.jks (PKCS12, alias "voicaw") and its random password in password, both
# readable only by you. If you publish on Google Play, this key can be its app signing key, so
# the APK from the website and the Play version update each other.
set -e
dir="${1:-${VOICAW_ANDROID_KEYS:-$HOME/.voicaw-android-keys}}"
if [ -e "$dir/voicaw-release.jks" ]; then
  echo "$dir/voicaw-release.jks already exists: not making another (it would break updates)." >&2
  exit 1
fi
umask 077
mkdir -p "$dir"
head -c 33 /dev/urandom | base64 | tr -d '/+=\n' > "$dir/password"
keytool -genkeypair -noprompt \
  -keystore "$dir/voicaw-release.jks" -storetype PKCS12 -storepass:file "$dir/password" \
  -alias voicaw -keyalg RSA -keysize 4096 -validity 36500 \
  -dname "CN=Voicaw, O=Voicaw"
chmod 600 "$dir/voicaw-release.jks" "$dir/password"
echo "Made $dir/voicaw-release.jks. Back up $dir now; its certificate's SHA-256:"
keytool -list -keystore "$dir/voicaw-release.jks" -storepass:file "$dir/password" -alias voicaw | grep -i "SHA-256\|SHA256"
