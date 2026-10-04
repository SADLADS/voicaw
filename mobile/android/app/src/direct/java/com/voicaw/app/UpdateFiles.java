package com.voicaw.app;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.regex.Pattern;

/** The parts of AppUpdater that need no Android, so JUnit can run them. */
final class UpdateFiles {
    /** What updates/publish-android.mjs names an APK; anything else (a path...) is refused. */
    private static final Pattern APK_NAME = Pattern.compile("voicaw-\\d{1,3}\\.\\d{1,2}\\.\\d{1,2}\\.apk");

    interface Progress {
        void onProgress(long received, long total);
    }

    private UpdateFiles() {}

    static boolean isApkName(String name) {
        return name != null && APK_NAME.matcher(name).matches();
    }

    /** Whether releases.json's versionCode is newer than this app's. */
    static boolean isNewer(long published, long installed) {
        return published > installed;
    }

    /**
     * Copies `in` to `out`, at most `size` bytes (more is an error: not the file releases.json
     * describes), and returns the copy's SHA-256 in lowercase hex. Fails if fewer arrive.
     */
    static String copyChecked(InputStream in, OutputStream out, long size, Progress progress) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
        byte[] buffer = new byte[64 * 1024];
        long received = 0;
        int read;
        while ((read = in.read(buffer)) != -1) {
            received += read;
            if (received > size) throw new IOException("The download is larger than the release says");
            digest.update(buffer, 0, read);
            out.write(buffer, 0, read);
            if (progress != null) progress.onProgress(received, size);
        }
        if (received != size) throw new IOException("The download stopped early");
        return hex(digest.digest());
    }

    static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) text.append(String.format("%02x", b));
        return text.toString();
    }
}
