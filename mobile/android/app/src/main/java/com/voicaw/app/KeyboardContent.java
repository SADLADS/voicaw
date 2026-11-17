package com.voicaw.app;

import android.content.Context;
import android.net.Uri;
import android.os.Build;

import androidx.core.view.inputmethod.InputConnectionCompat;
import androidx.core.view.inputmethod.InputContentInfoCompat;

import com.getcapacitor.JSObject;

import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A GIF or sticker from the keyboard (VoicawWebView), for the page's `keyboardContent` event
 * (client services/keyboardContent.js): `{ id, uri, name, type, size }`. As a share's files
 * (Share), the file stays in the keyboard's content:// address and the page reads it through
 * Capacitor's server, then says it's done (`releaseKeyboardContent`) and the keyboard's leave
 * to read it is given back.
 */
final class KeyboardContent {
    /** How long the page has to read one before its leave goes anyway. */
    static final long KEEP_MS = 5 * 60 * 1000;

    private static final class Held {
        final InputContentInfoCompat info;
        final long since;

        Held(InputContentInfoCompat info, long since) {
            this.info = info;
            this.since = since;
        }
    }

    private static final Map<String, Held> held = new ConcurrentHashMap<>();
    private static final AtomicInteger nextId = new AtomicInteger(1);
    // Asking the keyboard for the name and size is a call into its process: not on the input thread.
    private static final ExecutorService describing = Executors.newSingleThreadExecutor();

    private KeyboardContent() {}

    /**
     * The keyboard sent `info` (on the WebView's input thread). False tells it the box didn't take
     * it: no page listening (logged out), or not another app's file (Share.allowed).
     */
    static boolean received(Context context, InputContentInfoCompat info, int flags) {
        releaseOld(System.currentTimeMillis());
        Uri uri = info.getContentUri();
        if (!Share.allowed(uri.getScheme(), uri.getAuthority(), context.getPackageName())) return false;
        if (!VoicawPlugin.listensForKeyboardContent()) return false;
        if (Build.VERSION.SDK_INT >= 25 && (flags & InputConnectionCompat.INPUT_CONTENT_GRANT_READ_URI_PERMISSION) != 0) {
            try {
                info.requestPermission();
            } catch (Exception e) {
                return false;
            }
        }
        String id = String.valueOf(nextId.getAndIncrement());
        held.put(id, new Held(info, System.currentTimeMillis()));
        String declared = info.getDescription().getMimeTypeCount() > 0 ? info.getDescription().getMimeType(0) : null;
        describing.execute(() -> {
            JSObject file = Share.describe(context, uri, declared);
            if (file == null || !VoicawPlugin.emitKeyboardContent(file.put("id", id))) release(id);
        });
        return true;
    }

    /** The page has read it (or couldn't). */
    static void release(String id) {
        Held entry = id == null ? null : held.remove(id);
        if (entry != null) releasePermission(entry.info);
    }

    private static void releaseOld(long now) {
        for (Iterator<Map.Entry<String, Held>> it = held.entrySet().iterator(); it.hasNext();) {
            Held entry = it.next().getValue();
            if (now - entry.since < KEEP_MS) continue;
            it.remove();
            releasePermission(entry.info);
        }
    }

    private static void releasePermission(InputContentInfoCompat info) {
        try {
            info.releasePermission();
        } catch (Exception ignored) {
            // Never asked for (the keyboard gave no leave to drop), or already gone.
        }
    }
}
