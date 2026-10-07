package com.voicaw.app;

import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Files the page saves (VoicawPlugin `saveFileStart` / `saveFileAppend` / `saveFileFinish`),
 * written to the phone's Downloads folder. The WebView can't do it itself: it ignores
 * `<a download>`, and the page's files are blob: URLs only the page can read, so the page sends
 * their bytes over in pieces. Android 10+ through MediaStore (no permission needed); 8 and 9
 * straight into the folder, with the storage permission.
 */
final class Downloads {
    private static final class Pending {
        final Uri uri; // MediaStore's, or the file's own on Android 8 and 9
        final File file;
        final String mime;
        final OutputStream out;

        Pending(Uri uri, File file, String mime, OutputStream out) {
            this.uri = uri;
            this.file = file;
            this.mime = mime;
            this.out = out;
        }
    }

    private static final Map<String, Pending> pending = new ConcurrentHashMap<>();

    private Downloads() {}

    /** Whether saving needs the storage permission first (Android 8 and 9). */
    static boolean needsPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q;
    }

    /** A name safe to save as: no folders, no control characters, not too long. */
    static String safeName(String name) {
        String clean = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        while (clean.startsWith(".")) clean = clean.substring(1);
        if (clean.isEmpty()) clean = "download";
        if (clean.length() > 120) {
            int dot = clean.lastIndexOf('.');
            String ext = dot > 0 && clean.length() - dot <= 10 ? clean.substring(dot) : "";
            clean = clean.substring(0, 120 - ext.length()) + ext;
        }
        return clean;
    }

    private static String mimeFor(String name, String mime) {
        if (mime != null && !mime.isEmpty()) return mime;
        String ext = MimeTypeMap.getFileExtensionFromUrl(Uri.encode(name));
        String guessed = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        return guessed != null ? guessed : "application/octet-stream";
    }

    /** Starts a file called (about) `name`; returns its id for append / finish. */
    static String start(Context context, String name, String mime) throws IOException {
        String fileName = safeName(name);
        String type = mimeFor(fileName, mime);
        Pending file;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = context.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
            values.put(MediaStore.Downloads.MIME_TYPE, type);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            // MediaStore numbers the name itself if there's already one.
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("Couldn't create the file");
            OutputStream out = resolver.openOutputStream(uri);
            if (out == null) {
                resolver.delete(uri, null, null);
                throw new IOException("Couldn't open the file");
            }
            file = new Pending(uri, null, type, out);
        } else {
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("No Downloads folder");
            File target = unusedFile(dir, fileName);
            file = new Pending(Uri.fromFile(target), target, type, new FileOutputStream(target));
        }
        String id = UUID.randomUUID().toString();
        pending.put(id, file);
        return id;
    }

    /** "name.ext", or "name (2).ext" and so on if that's taken. */
    private static File unusedFile(File dir, String name) {
        File file = new File(dir, name);
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int n = 2; file.exists(); n++) file = new File(dir, base + " (" + n + ")" + ext);
        return file;
    }

    static void append(String id, byte[] bytes) throws IOException {
        Pending file = pending.get(id);
        if (file == null) throw new IOException("No such file");
        file.out.write(bytes);
    }

    /** Ends the file and shows it in Downloads; returns a uri other apps may open it with. */
    static Uri finish(Context context, String id) throws IOException {
        Pending file = pending.remove(id);
        if (file == null) throw new IOException("No such file");
        file.out.close();
        if (file.file == null) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            context.getContentResolver().update(file.uri, values, null, null);
            return file.uri;
        }
        MediaScannerConnection.scanFile(context, new String[] { file.file.getPath() }, new String[] { file.mime }, null);
        return FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file.file);
    }

    /** Throws away a file the page couldn't finish. */
    static void cancel(Context context, String id) {
        Pending file = pending.remove(id);
        if (file == null) return;
        try {
            file.out.close();
        } catch (IOException ignored) {
            // Deleted anyway.
        }
        if (file.file == null) context.getContentResolver().delete(file.uri, null, null);
        else if (!file.file.delete()) file.file.deleteOnExit();
    }

    /** Opens a saved file in whichever app handles its type; false if none does. */
    static boolean open(Context context, Uri uri, String mime) {
        Intent intent = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, mime)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            return true;
        } catch (ActivityNotFoundException e) {
            return false;
        }
    }

    static String mimeOf(Context context, Uri uri) {
        String type = context.getContentResolver().getType(uri);
        return type != null ? type : "application/octet-stream";
    }
}
