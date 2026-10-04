package com.voicaw.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * What Android's installer says about an update AppUpdater handed it: it needs the person to
 * confirm (its screen is shown), or it failed or was cancelled (the page is told, so "Update"
 * works again). Installing replaces the running app, which then just closes, so once the new
 * version is in (MY_PACKAGE_REPLACED) a notification offers to open it.
 */
public class UpdateStatusReceiver extends BroadcastReceiver {
    private static final String TAG = "VoicawUpdate";
    private static final String CHANNEL = "updates";
    private static final String PREFS = "voicaw.update";
    private static final String PENDING = "pending";
    private static final int NOTIFICATION_ID = 0x5550;

    /** Before installing: so the new version knows it was this app that updated it. */
    static void rememberPending(Context context) {
        prefs(context).edit().putBoolean(PENDING, true).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
            if (prefs(context).getBoolean(PENDING, false)) {
                prefs(context).edit().remove(PENDING).apply();
                showUpdated(context);
            }
            return;
        }
        if (!AppUpdater.ACTION_INSTALL_STATUS.equals(intent.getAction())) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(confirm);
            }
            return;
        }
        if (status == PackageInstaller.STATUS_SUCCESS) return; // this process is about to go
        prefs(context).edit().remove(PENDING).apply();
        String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        Log.w(TAG, "Update not installed: " + status + " " + message);
        VoicawPlugin.emitUpdateResult(status == PackageInstaller.STATUS_FAILURE_ABORTED ? "aborted" : "failed", message);
    }

    private static void showUpdated(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, context.getString(R.string.channel_updates), NotificationManager.IMPORTANCE_DEFAULT);
            channel.setSound(null, null);
            context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
        Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(context, NOTIFICATION_ID, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.update_installed_title))
            .setContentText(context.getString(R.string.update_installed_text, BuildConfig.VERSION_NAME))
            .setContentIntent(tap)
            .setAutoCancel(true);
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build());
        } catch (SecurityException e) {
            Log.i(TAG, "Updated, but notifications are off");
        }
    }
}
