package com.voicaw.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;

import com.getcapacitor.JSObject;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Updates for the APK from updates.voicaw.com (this is the `direct` build's; Play's never
 * updates itself, as Play requires). The page asks (VoicawPlugin `checkForUpdate`,
 * `installUpdate`): releases.json names the newest version (updates/publish-android.mjs); on
 * "Update" its APK is downloaded into the app's cache and checked (the size and SHA-256
 * releases.json gives, this app's package, a higher version, signed by the same key), then
 * handed to Android's installer, which asks the person to confirm (UpdateStatusReceiver).
 *
 * The hash only catches a broken download: it comes from the same server as the APK. What
 * stops a swapped APK is Android refusing to update an app with one signed by another key;
 * the signature check here only says so before the person is asked.
 */
final class AppUpdater {
    static final String ACTION_INSTALL_STATUS = "com.voicaw.app.UPDATE_STATUS";

    interface Progress extends UpdateFiles.Progress {}

    private static final int TIMEOUT_MS = 20_000;

    private static final class Release {
        String version;
        long versionCode;
        String file;
        long size;
        String sha256;
    }

    private AppUpdater() {}

    /** { supported, current, available, version (the newest), size (its APK's bytes) }. */
    static JSObject check(Context context) throws IOException, JSONException {
        Release release = fetchLatest();
        return new JSObject()
            .put("supported", true)
            .put("current", BuildConfig.VERSION_NAME)
            .put("available", UpdateFiles.isNewer(release.versionCode, BuildConfig.VERSION_CODE))
            .put("version", release.version)
            .put("size", release.size);
    }

    /**
     * Downloads the newest version, checks it and asks Android to install it. Returns once
     * Android has it: its confirmation comes next (UpdateStatusReceiver).
     */
    static void downloadAndInstall(Context context, Progress progress) throws IOException, JSONException {
        Release release = fetchLatest();
        if (!UpdateFiles.isNewer(release.versionCode, BuildConfig.VERSION_CODE)) {
            throw new IOException("This is already the newest version");
        }
        File apk = download(context, release, progress);
        checkApk(context, apk, release);
        install(context, apk);
    }

    private static Release fetchLatest() throws IOException, JSONException {
        HttpURLConnection connection = open(BuildConfig.UPDATE_URL + "releases.json");
        try {
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            try (InputStream in = connection.getInputStream()) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    body.write(buffer, 0, read);
                    if (body.size() > 64 * 1024) throw new IOException("releases.json is too large");
                }
            }
            JSONObject android = new JSONObject(body.toString(StandardCharsets.UTF_8.name())).getJSONObject("android");
            JSONObject file = android.getJSONObject("file");
            Release release = new Release();
            release.version = android.getString("version");
            release.versionCode = android.getLong("versionCode");
            release.file = file.getString("name");
            release.size = file.getLong("size");
            release.sha256 = file.getString("sha256").toLowerCase();
            if (!UpdateFiles.isApkName(release.file)) throw new IOException("Unexpected file name " + release.file);
            return release;
        } finally {
            connection.disconnect();
        }
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(TIMEOUT_MS);
        connection.setReadTimeout(TIMEOUT_MS);
        connection.setUseCaches(false);
        int status = connection.getResponseCode();
        if (status != HttpURLConnection.HTTP_OK) {
            connection.disconnect();
            throw new IOException("HTTP " + status + " for " + url);
        }
        return connection;
    }

    /** Into the cache (`updates/`, emptied first, so only one APK is ever kept). */
    private static File download(Context context, Release release, Progress progress) throws IOException {
        File dir = new File(context.getCacheDir(), "updates");
        File[] old = dir.listFiles();
        if (old != null) for (File file : old) file.delete();
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("No room for the download");

        File part = new File(dir, release.file + ".part");
        File apk = new File(dir, release.file);
        HttpURLConnection connection = open(BuildConfig.UPDATE_URL + release.file);
        String sha256;
        try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(part)) {
            sha256 = UpdateFiles.copyChecked(in, out, release.size, progress);
        } catch (IOException e) {
            part.delete();
            throw e;
        } finally {
            connection.disconnect();
        }
        if (!sha256.equals(release.sha256)) {
            part.delete();
            throw new IOException("The download doesn't match its SHA-256");
        }
        if (!part.renameTo(apk)) throw new IOException("Couldn't keep the download");
        return apk;
    }

    @SuppressWarnings("deprecation")
    private static void checkApk(Context context, File apk, Release release) throws IOException {
        PackageManager pm = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo update = pm.getPackageArchiveInfo(apk.getPath(), flags);
        if (update == null) throw new IOException("The download isn't an app");
        if (!context.getPackageName().equals(update.packageName)) throw new IOException("The download is another app");
        long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? update.getLongVersionCode() : update.versionCode;
        if (versionCode != release.versionCode) throw new IOException("The download isn't the version releases.json names");

        Set<Signature> updateSigners = signers(update);
        if (updateSigners == null) return; // this Android couldn't read them: its installer checks anyway
        try {
            PackageInfo installed = pm.getPackageInfo(context.getPackageName(), flags);
            if (!updateSigners.equals(signers(installed))) {
                throw new IOException("The download isn't signed with this app's key");
            }
        } catch (PackageManager.NameNotFoundException e) {
            throw new IOException(e);
        }
    }

    @SuppressWarnings("deprecation")
    private static Set<Signature> signers(PackageInfo info) {
        Signature[] list;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            list = info.signingInfo != null ? info.signingInfo.getApkContentsSigners() : null;
        } else {
            list = info.signatures;
        }
        return list == null || list.length == 0 ? null : new HashSet<>(Arrays.asList(list));
    }

    private static void install(Context context, File apk) throws IOException {
        PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(context.getPackageName());
        params.setSize(apk.length());
        int sessionId = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(sessionId)) {
            try (InputStream in = new FileInputStream(apk); OutputStream out = session.openWrite("voicaw.apk", 0, apk.length())) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
                session.fsync(out);
            }
            // Mutable: the installer adds the outcome (and the confirmation to show) to it.
            Intent status = new Intent(context, UpdateStatusReceiver.class).setAction(ACTION_INSTALL_STATUS);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
            UpdateStatusReceiver.rememberPending(context);
            session.commit(PendingIntent.getBroadcast(context, sessionId, status, flags).getIntentSender());
        } catch (IOException | RuntimeException e) {
            installer.abandonSession(sessionId);
            throw e;
        }
    }
}
