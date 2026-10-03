package com.voicaw.app;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;

import org.json.JSONObject;

/**
 * While in a call or voice channel: a foreground service with the ongoing-call notification
 * (Mute / Unmute and Hang up), so Android keeps the app, its microphone and its audio running
 * with the screen off or another app in front. Started and updated by the page
 * (VoicawPlugin.setOngoing), stopped when it leaves voice.
 */
public class CallService extends Service {
    private static final String TAG = "VoicawCall";
    private static final int NOTIFICATION_ID = 1;

    private static CallService running;
    // What the notification shows (the page's ongoingNotification()).
    private static JSObject shown;

    private PowerManager.WakeLock wakeLock;

    static synchronized void show(Context context, JSObject ongoing) {
        shown = ongoing;
        if (running != null) {
            running.post();
            return;
        }
        try {
            ContextCompat.startForegroundService(context, new Intent(context, CallService.class));
        } catch (Exception e) {
            // Android 12+ won't start one from the background; the page is in front when it joins.
            Log.w(TAG, "Couldn't start the call service", e);
        }
    }

    static synchronized void stop(Context context) {
        shown = null;
        context.stopService(new Intent(context, CallService.class));
    }

    @SuppressLint("WakelockTimeout")
    @Override
    public void onCreate() {
        super.onCreate();
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "voicaw:call");
        wakeLock.acquire();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        synchronized (CallService.class) {
            if (shown == null) {
                stopSelf();
                return START_NOT_STICKY;
            }
            running = this;
            try {
                ServiceCompat.startForeground(
                    this, NOTIFICATION_ID, build(),
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0
                );
            } catch (Exception e) {
                Log.w(TAG, "Couldn't keep the call running", e);
                stopSelf();
            }
        }
        // Not restarted if Android kills it: the call is gone with the page anyway.
        return START_NOT_STICKY;
    }

    private void post() {
        try {
            NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, build());
        } catch (SecurityException ignored) {
            // Notifications off: the service keeps running all the same.
        }
    }

    private Notification build() {
        Notifications.createChannels(this);
        JSObject ongoing = shown;
        JSONObject labels = ongoing.optJSONObject("labels");
        if (labels == null) labels = new JSONObject();
        boolean muted = ongoing.optBoolean("muted");
        int flags = Notifications.flags();
        PendingIntent open = PendingIntent.getActivity(this, 0, Notifications.openApp(this, null), flags);
        PendingIntent toggle = PendingIntent.getBroadcast(
            this, 1, CallActionReceiver.intent(this, muted ? CallActionReceiver.UNMUTE : CallActionReceiver.MUTE), flags);
        PendingIntent hangUp = PendingIntent.getBroadcast(this, 2, CallActionReceiver.intent(this, CallActionReceiver.HANG_UP), flags);
        return new NotificationCompat.Builder(this, Notifications.ONGOING)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(getColor(R.color.notification))
            .setContentTitle(ongoing.getString("title", getString(R.string.app_name)))
            .setContentText(ongoing.getString("text", ""))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setContentIntent(open)
            .addAction(0, labels.optString(muted ? "unmute" : "mute", getString(muted ? R.string.unmute : R.string.mute)), toggle)
            .addAction(0, labels.optString("hangUp", getString(R.string.hang_up)), hangUp)
            .build();
    }

    @Override
    public void onDestroy() {
        synchronized (CallService.class) {
            if (running == this) running = null;
        }
        if (wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
