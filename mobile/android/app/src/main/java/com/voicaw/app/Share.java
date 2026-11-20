package com.voicaw.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
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

    /**
     * As above, for the share sheet, which any app can fill: the phone's gallery (MediaStore,
     * content://media/...) also needs `senderReadsMedia`. Voicaw may read every photo (the +
     * panel's grid), so an app without that permission could otherwise put any photo on the share
     * screen by its number (security audit, 2026-11-20). Photo picker addresses
     * (content://media/picker...) are only readable with a grant, so they pass as before.
     */
    static boolean allowedShare(String scheme, String authority, String firstPathSegment, String ownPackage, boolean senderReadsMedia) {
        if (!allowed(scheme, authority, ownPackage)) return false;
        if (!MediaStore.AUTHORITY.equals(authority) || senderReadsMedia) return true;
        return firstPathSegment != null && firstPathSegment.startsWith("picker");
    }

    /**
     * The app that sent `intent` to `activity`, as the system says (never the intent's own
     * EXTRA_REFERRER*, which the sender writes), or null. Through the share sheet it's the app
     * that shared, not the sheet. Read while the intent is being delivered.
     */
    static String sender(Activity activity, Intent intent) {
        if (activity == null || hasReferrerExtra(intent) || hasReferrerExtra(activity.getIntent())) return null;
        Uri referrer = activity.getReferrer();
        return referrer != null && "android-app".equals(referrer.getScheme()) ? referrer.getHost() : null;
    }

    private static boolean hasReferrerExtra(Intent intent) {
        return intent != null && (intent.hasExtra(Intent.EXTRA_REFERRER) || intent.hasExtra(Intent.EXTRA_REFERRER_NAME));
    }

    /** Whether `pkg` may read the gallery itself: a photo or video permission, or a system app. */
    static boolean readsMedia(Context context, String pkg) {
        if (pkg == null) return false;
        PackageManager pm = context.getPackageManager();
        for (String permission : MEDIA_PERMISSIONS) {
            if (pm.checkPermission(permission, pkg) == PackageManager.PERMISSION_GRANTED) return true;
        }
        try {
            ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
            return (info.flags & (ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private static final String[] MEDIA_PERMISSIONS = {
        "android.permission.READ_MEDIA_IMAGES",
        "android.permission.READ_MEDIA_VIDEO",
        "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.MANAGE_EXTERNAL_STORAGE",
    };

    /**
     * The share in `intent`, or null if nothing in it can be shared. `senderReadsMedia`: whether
     * the app that shared may read the gallery itself (readsMedia of sender).
     */
    static JSObject read(Context context, Intent intent, boolean senderReadsMedia) {
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
            if (uri == null || !allowedShare(uri.getScheme(), uri.getAuthority(), first(uri), context.getPackageName(), senderReadsMedia)) {
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

    private static String first(Uri uri) {
        List<String> segments = uri.getPathSegments();
        return segments.isEmpty() ? null : segments.get(0);
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

    /**
     * Its name, type and size, or null if it can't be opened. `intentType`: the type it was
     * offered as, if the provider doesn't say (also KeyboardContent's).
     */
    static JSObject describe(Context context, Uri uri, String intentType) {
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
