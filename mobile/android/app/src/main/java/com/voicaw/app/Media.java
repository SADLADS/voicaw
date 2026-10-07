package com.voicaw.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Size;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;

/**
 * The phone's photos and videos, newest first, for the message box's + panel (VoicawPlugin
 * `mediaAccess` / `requestMediaAccess` / `listMedia` / `mediaThumbnail`). Only listed and
 * shown on the phone: the page reads a file (through Capacitor's `_capacitor_content_` route)
 * only once it's picked, and it's then sent like any other attachment.
 */
final class Media {
    private Media() {}

    /** The permissions to ask for on this Android version (VoicawPlugin's aliases). */
    static String alias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? "media" : "mediaLegacy";
    }

    private static boolean granted(Context context, String permission) {
        return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * "all", "some" (Android 14+: only the photos the person chose; asking again lets them
     * choose more) or "none".
     */
    static String access(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (granted(context, Manifest.permission.READ_MEDIA_IMAGES)) return "all";
            if (Build.VERSION.SDK_INT >= 34 && granted(context, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)) return "some";
            return "none";
        }
        return granted(context, Manifest.permission.READ_EXTERNAL_STORAGE) ? "all" : "none";
    }

    /** `limit` items from `offset`: { id, uri, type, name, size, duration (ms, videos) }. */
    static JSArray list(Context context, int offset, int limit) {
        JSArray items = new JSArray();
        if ("none".equals(access(context))) return items;
        Uri files = MediaStore.Files.getContentUri("external");
        String[] columns = {
            MediaStore.Files.FileColumns._ID,
            MediaStore.Files.FileColumns.MEDIA_TYPE,
            MediaStore.Files.FileColumns.MIME_TYPE,
            MediaStore.Files.FileColumns.DISPLAY_NAME,
            MediaStore.Files.FileColumns.SIZE,
            MediaStore.Video.VideoColumns.DURATION,
        };
        String where = MediaStore.Files.FileColumns.MEDIA_TYPE + " IN ("
            + MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE + ","
            + MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO + ") AND "
            + MediaStore.Files.FileColumns.SIZE + " > 0";
        String order = MediaStore.Files.FileColumns.DATE_ADDED + " DESC";
        try (Cursor cursor = context.getContentResolver().query(files, columns, where, null, order)) {
            if (cursor == null || !cursor.moveToPosition(offset)) return items;
            do {
                long id = cursor.getLong(0);
                boolean video = cursor.getInt(1) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO;
                Uri base = video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                JSObject item = new JSObject()
                    .put("id", (video ? "v" : "i") + id)
                    .put("uri", ContentUris.withAppendedId(base, id).toString())
                    .put("type", cursor.getString(2))
                    .put("name", cursor.getString(3))
                    .put("size", cursor.getLong(4));
                if (video) item.put("duration", cursor.getLong(5));
                items.put(item);
            } while (items.length() < limit && cursor.moveToNext());
        }
        return items;
    }

    /** A JPEG about `size` px across of the photo or video's first frame, as a data: URL. */
    static String thumbnail(Context context, String uriString, int size) throws IOException {
        Uri uri = Uri.parse(uriString);
        if (!"media".equals(uri.getAuthority())) throw new IOException("Not the phone's media");
        ContentResolver resolver = context.getContentResolver();
        Bitmap bitmap;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            bitmap = resolver.loadThumbnail(uri, new Size(size, size), null);
        } else {
            long id = ContentUris.parseId(uri);
            bitmap = uriString.contains("/video/")
                ? MediaStore.Video.Thumbnails.getThumbnail(resolver, id, MediaStore.Video.Thumbnails.MINI_KIND, null)
                : MediaStore.Images.Thumbnails.getThumbnail(resolver, id, MediaStore.Images.Thumbnails.MINI_KIND, null);
        }
        if (bitmap == null) throw new IOException("No thumbnail");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out);
        bitmap.recycle();
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }
}
