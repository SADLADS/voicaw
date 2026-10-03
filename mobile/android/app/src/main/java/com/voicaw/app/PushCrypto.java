package com.voicaw.app;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.Base64;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.zip.Inflater;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * FCM doesn't encrypt to the device, so the server encrypts every push with a key this phone
 * made and registered with its token (server/fcm.js): the message's data is
 * { v: "1", p: base64(12-byte IV || AES-256-GCM(deflate(JSON)) || tag) }.
 */
final class PushCrypto {
    private static final String PREFS = "voicaw-push";
    private static final String KEY = "deviceKey";

    private PushCrypto() {}

    /** This phone's push key (base64), made the first time. Kept in the app's private storage. */
    static synchronized String deviceKey(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String key = prefs.getString(KEY, null);
        if (key == null) {
            byte[] bytes = new byte[32];
            new SecureRandom().nextBytes(bytes);
            key = Base64.getEncoder().encodeToString(bytes);
            prefs.edit().putString(KEY, key).apply();
        }
        return key;
    }

    /** The push's JSON, or throws if it wasn't sealed with `key`. */
    static String open(String key, String sealed) throws Exception {
        byte[] data = Base64.getDecoder().decode(sealed);
        if (data.length < 12 + 16) throw new IllegalArgumentException("Push too short");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(
            Cipher.DECRYPT_MODE,
            new SecretKeySpec(Base64.getDecoder().decode(key), "AES"),
            new GCMParameterSpec(128, Arrays.copyOfRange(data, 0, 12))
        );
        byte[] deflated = cipher.doFinal(data, 12, data.length - 12);
        return new String(inflate(deflated), StandardCharsets.UTF_8);
    }

    private static byte[] inflate(byte[] deflated) throws Exception {
        Inflater inflater = new Inflater(true);
        inflater.setInput(deflated);
        ByteArrayOutputStream out = new ByteArrayOutputStream(deflated.length * 3);
        byte[] buffer = new byte[4096];
        try {
            while (!inflater.finished()) {
                int n = inflater.inflate(buffer);
                if (n == 0 && (inflater.needsInput() || inflater.needsDictionary())) break;
                out.write(buffer, 0, n);
                if (out.size() > 64 * 1024) throw new IllegalArgumentException("Push too big");
            }
        } finally {
            inflater.end();
        }
        return out.toByteArray();
    }
}
