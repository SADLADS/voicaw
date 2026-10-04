package com.voicaw.app;

import android.content.Context;

import com.getcapacitor.JSObject;

import java.io.IOException;

/**
 * Google Play's build: Play updates it, and its rules forbid an app from Play updating itself
 * any other way, so this never does (the `direct` build's AppUpdater does).
 */
final class AppUpdater {
    interface Progress {
        void onProgress(long received, long total);
    }

    private AppUpdater() {}

    static JSObject check(Context context) {
        return new JSObject().put("supported", false).put("current", BuildConfig.VERSION_NAME);
    }

    static void downloadAndInstall(Context context, Progress progress) throws IOException {
        throw new IOException("Google Play updates this app");
    }
}
