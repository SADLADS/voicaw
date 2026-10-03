package com.voicaw.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The last pushes this phone got and what became of each (shown, silent, not allowed, couldn't
 * be opened...), for Settings → Android App: a phone's own logs are out of reach, and a push
 * that shows nothing otherwise leaves no trace. Only the time, kind and outcome are kept, never
 * a message, name or token.
 */
final class PushLog {
    private static final String PREFS = "voicaw-push-log";
    private static final String KEY = "entries";
    private static final int KEEP = 20;

    private PushLog() {}

    static synchronized void add(Context context, String type, String outcome) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONArray entries = read(prefs);
        JSONArray next = new JSONArray();
        try {
            next.put(new JSONObject().put("at", System.currentTimeMillis()).put("type", type == null ? "" : type).put("outcome", outcome));
            for (int i = 0; i < entries.length() && next.length() < KEEP; i++) next.put(entries.get(i));
        } catch (Exception ignored) {
            return;
        }
        prefs.edit().putString(KEY, next.toString()).apply();
    }

    /** Newest first: [{ at (ms), type, outcome }]. */
    static synchronized JSONArray entries(Context context) {
        return read(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE));
    }

    private static JSONArray read(SharedPreferences prefs) {
        try {
            return new JSONArray(prefs.getString(KEY, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }
}
