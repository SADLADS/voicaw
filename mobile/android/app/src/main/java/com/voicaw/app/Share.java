package com.voicaw.app;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Something shared to Voicaw from another app (Android's share sheet: the manifest's SEND and
 * SEND_MULTIPLE filters), for the page's share screen (client components/ShareDialog.jsx):
 * `{ files: [{ uri, name, type, size }], text }`. Files stay where they are (content:// URIs
 * the sharing app let us read for as long as the activity lives) and are read by the page
 * through Capacitor's server only when sent, as the + panel's photos are (android.js readMedia).
 */
final class Share {
    /** As many files as one message takes (the share screen sends them as one message). */
    static final int MAX_FILES = 10;

    private Share() {}

    static boolean isShare(Intent intent) {
        String action = intent == null ? null : intent.getAction();
        return Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action);
    }

    /**
     * Whether a shared file may be read: only another app's content:// files. Never file://
     * (any path the app itself can read) nor one of the app's own providers (its cache and
     * downloads, through the FileProvider): another app could otherwise "share" Voicaw's own
     * files, decrypted attachments included, for the person to send on without knowing.
     */
    static boolean allowed(String scheme, String authority, String ownPackage) {
        if (!ContentResolver.SCHEME_CONTENT.equals(scheme) || authority == null || authority.isEmpty()) return false;
        return !authority.equals(ownPackage) && !authority.startsWith(ownPackage + ".");
    }

    /** The share in `intent`, or null if nothing in it can be shared. */
    static JSObject read(Context context, Intent intent) {
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            List<Uri> list = streams(intent);
            if (list != null) uris.addAll(list);
        } else {
            Uri uri = stream(intent);
            if (uri != null) uris.add(uri);
        }

        JSArray files = new JSArray();
        int skipped = 0;
        for (Uri uri : uris) {
            if (uri == null || !allowed(uri.getScheme(), uri.getAuthority(), context.getPackageName())) {
                skipped++;
                continue;
            }
            if (files.length() >= MAX_FILES) {
                skipped++;
                continue;
            }
            JSObject file = describe(context, uri, intent.getType());
            if (file == null) skipped++;
            else files.put(file);
        }

        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String shared = text == null ? "" : text.toString().trim();
        if (files.length() == 0 && shared.isEmpty()) return null;
        return new JSObject().put("files", files).put("text", shared).put("skipped", skipped);
    }

    @SuppressWarnings("deprecation")
    private static Uri stream(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    @SuppressWarnings("deprecation")
    private static List<Uri> streams(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
        return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
    }

    /** Its name, type and size, or null if it can't be opened. */
    private static JSObject describe(Context context, Uri uri, String intentType) {
        ContentResolver resolver = context.getContentResolver();
        String name = null;
        long size = -1;
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameAt = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeAt = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameAt != -1 && !cursor.isNull(nameAt)) name = cursor.getString(nameAt);
                if (sizeAt != -1 && !cursor.isNull(sizeAt)) size = cursor.getLong(sizeAt);
            }
        } catch (Exception e) {
            // No permission after all, or a provider that's gone.
            return null;
        }
        String type = null;
        try {
            type = resolver.getType(uri);
        } catch (Exception ignored) {
            // The intent's type below.
        }
        if (type == null && intentType != null && !intentType.contains("*")) type = intentType;
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment();
        return new JSObject()
            .put("uri", uri.toString())
            .put("name", name == null ? "file" : name)
            .put("type", type == null ? "" : type)
            .put("size", size);
    }
}
