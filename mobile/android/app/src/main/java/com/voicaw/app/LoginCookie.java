package com.voicaw.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import android.webkit.CookieManager;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * The app's own copy of the login cookie (server/auth.js `voicaw_session`), kept in the app's
 * private storage and put back into the WebView before the page loads when the WebView has lost
 * it. Since the login moved into that HttpOnly cookie (android-v1.3.1), closing and reopening the
 * app opened it on the login screen though the login was still good: the WebView didn't keep the
 * API's cross-site cookie across a restart (accepting it before the page loads, 1.3.2, wasn't
 * enough). The desktop app's main process keeps its login the same way (electron/apiLogin.js).
 * The page never sees it: only this class and the WebView's cookie store hold it.
 *
 * It follows the WebView whenever the app goes to the background: a cookie there is saved (a
 * login, a renewal), none means logged out (logout and a refused login clear it) and the copy
 * is forgotten. Only for the built-in API address, from the build (voicaw-api.json, as the
 * desktop app's), never from the page.
 */
final class LoginCookie {
    private static final String TAG = "VoicawLoginCookie";
    private static final String NAME = "voicaw_session";
    private static final String PREFS = "voicaw_login_cookie";
    /** The cookie's life (server/auth.js SESSION_SECONDS); renewed with every new value. */
    static final long LIFE_SECONDS = 30L * 24 * 60 * 60;

    private LoginCookie() {}

    /** The built-in API's address ("https://app.voicaw.com/api/"), or null. */
    static String apiUrl(Context context) {
        try (InputStream in = context.getAssets().open("public/voicaw-api.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[1024];
            for (int n; (n = in.read(buffer)) > 0; ) bytes.write(buffer, 0, n);
            String api = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8)).optString("api", "");
            return api.startsWith("https://") ? api : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** The login cookie's value in a CookieManager.getCookie answer ("a=b; voicaw_session=..."), or null. */
    static String valueIn(String cookies) {
        if (cookies == null) return null;
        for (String part : cookies.split(";")) {
            int at = part.indexOf('=');
            if (at < 0 || !part.substring(0, at).trim().equals(NAME)) continue;
            String value = part.substring(at + 1).trim();
            return value.matches("[A-Za-z0-9_\\-.]{1,4096}") ? value : null;
        }
        return null;
    }

    /** The Set-Cookie line that puts a value back, as the server sets it, for what's left of its life. */
    static String cookieLine(String value, long maxAgeSeconds) {
        return NAME + "=" + value + "; Path=/api; Max-Age=" + maxAgeSeconds + "; HttpOnly; Secure; SameSite=None";
    }

    /** Seconds left of a value first seen at `savedAtMs`. */
    static long secondsLeft(long savedAtMs, long nowMs) {
        return LIFE_SECONDS - (nowMs - savedAtMs) / 1000;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Puts the saved cookie back if the WebView lost it. Before the page loads (VoicawWebView). */
    static void restore(Context context) {
        try {
            String api = apiUrl(context);
            if (api == null) return;
            CookieManager cookies = CookieManager.getInstance();
            if (valueIn(cookies.getCookie(api)) != null) return;
            SharedPreferences saved = prefs(context);
            String value = valueIn(NAME + "=" + saved.getString("value", ""));
            if (value == null) return;
            long left = secondsLeft(saved.getLong("savedAt", 0), System.currentTimeMillis());
            if (left <= 60) {
                saved.edit().clear().apply();
                return;
            }
            cookies.setCookie(api, cookieLine(value, left));
            cookies.flush();
            Log.i(TAG, "Put the login cookie back (the WebView had lost it)");
        } catch (Exception e) {
            Log.w(TAG, "Could not put the login cookie back", e);
        }
    }

    /** Follows the WebView's cookie: saved when there is one, forgotten when there's none. */
    static void save(Context context) {
        try {
            String api = apiUrl(context);
            if (api == null) return;
            String value = valueIn(CookieManager.getInstance().getCookie(api));
            SharedPreferences saved = prefs(context);
            if (value == null) {
                if (saved.contains("value")) saved.edit().clear().apply();
            } else if (!value.equals(saved.getString("value", null))) {
                saved.edit().putString("value", value).putLong("savedAt", System.currentTimeMillis()).apply();
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not save the login cookie", e);
        }
    }
}
