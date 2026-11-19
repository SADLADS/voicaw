package com.voicaw.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

/**
 * A random key, made once per install and kept in the app's own storage, that the app's own
 * notification intents carry (Notifications.openApp). MainActivity is exported (the launcher and
 * the share sheet start it), so any app on the phone can start it with whatever extras it likes:
 * "answer this call" and "go to this page" are only taken from an intent with the key (security
 * audit, 2026-11-18).
 */
final class IntentKey {
    static final String EXTRA = "voicaw.key";
    private static final String PREFS = "voicaw-intent-key";
    private static final String KEY = "key";
    private static String cached;

    private IntentKey() {}

    static synchronized String get(Context context) {
        if (cached != null) return cached;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String key = prefs.getString(KEY, null);
        if (key == null) {
            byte[] bytes = new byte[32];
            new SecureRandom().nextBytes(bytes);
            key = Base64.encodeToString(bytes, Base64.NO_WRAP);
            prefs.edit().putString(KEY, key).commit();
        }
        cached = key;
        return key;
    }

    /** Whether `intent` came from the app itself (carries the key). */
    static boolean fromApp(Context context, Intent intent) {
        return same(get(context), intent.getStringExtra(EXTRA));
    }

    /** `given` is `expected` (compared in constant time); never true for a missing one. */
    static boolean same(String expected, String given) {
        if (expected == null || given == null) return false;
        return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), given.getBytes(StandardCharsets.UTF_8));
    }
}
