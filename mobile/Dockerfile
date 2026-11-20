# The Android build environment (`npm run dist:android`, see mobile/dist-android.sh): JDK 21
# and the Android SDK, so the host needs only Docker. Built once as voicaw-android-build;
# Gradle's downloads are kept in ~/.gradle on the host. The base image is pinned by digest and the
# command-line tools by SHA-256 (the release key is used in this image, mobile/sign-android.sh):
# updating either is a deliberate edit (`docker buildx imagetools inspect eclipse-temurin:21-jdk`;
# the tools' checksum is on developer.android.com/studio), then `docker rmi voicaw-android-build`.
FROM eclipse-temurin:21-jdk@sha256:db5cc6341a1d7bc40cdb51e1f0d9824f3bb2cc8107d29da421dc4df7d11f05f1
ENV ANDROID_HOME=/opt/android-sdk
RUN apt-get update && apt-get install -y --no-install-recommends unzip curl && rm -rf /var/lib/apt/lists/* \
 && mkdir -p $ANDROID_HOME/cmdline-tools \
 && curl -fsSL -o /tmp/tools.zip https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip \
 && echo "7ec965280a073311c339e571cd5de778b9975026cfcbe79f2b1cdcb1e15317ee  /tmp/tools.zip" | sha256sum -c - \
 && unzip -q /tmp/tools.zip -d $ANDROID_HOME/cmdline-tools \
 && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
 && rm /tmp/tools.zip \
 && yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null \
 && $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "build-tools;35.0.0" > /dev/null \
 && chmod -R a+rwX $ANDROID_HOME
