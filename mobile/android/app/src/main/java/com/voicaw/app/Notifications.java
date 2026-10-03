package com.voicaw.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.graphics.drawable.IconCompat;

import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * What the app shows for a push (server/push.js payloads, opened by PushService): messages,
 * calls ringing with Answer and Decline, missed calls. The words come from the hidden page
 * (NotifyRenderer: previews decrypted there); the push's own title and body if it can't.
 */
final class Notifications {
    private static final String TAG = "VoicawNotify";

    static final String MESSAGES = "messages";
    static final String MENTIONS = "mentions";
    static final String CALLS = "calls";
    static final String MISSED_CALLS = "missed_calls";
    static final String ONGOING = "ongoing";

    static final String EXTRA_URL = "voicaw.url";
    static final String EXTRA_ANSWER = "voicaw.answer";
    static final String EXTRA_CALL_ID = "voicaw.callId";

    // How long a call rings (server/calls.js RING_MS), in case its "missed" push never comes.
    private static final long RING_MS = 45_000;
    // How long the page may take to word a notification (calls ring sooner, with the push's
    // own words if need be).
    private static final long RENDER_MS = 8_000;
    private static final long RENDER_CALL_MS = 3_000;

    // The caller's picture for the ringing screen, by call id.
    static final Map<String, Bitmap> callerPictures = new ConcurrentHashMap<>();

    private Notifications() {}

    static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel messages = new NotificationChannel(MESSAGES, context.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription(context.getString(R.string.channel_messages_description));
        NotificationChannel mentions = new NotificationChannel(MENTIONS, context.getString(R.string.channel_mentions), NotificationManager.IMPORTANCE_HIGH);
        mentions.setDescription(context.getString(R.string.channel_mentions_description));
        NotificationChannel calls = new NotificationChannel(CALLS, context.getString(R.string.channel_calls), NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription(context.getString(R.string.channel_calls_description));
        calls.setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        );
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] { 0, 1000, 1000 });
        calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        NotificationChannel missed = new NotificationChannel(MISSED_CALLS, context.getString(R.string.channel_missed_calls), NotificationManager.IMPORTANCE_DEFAULT);
        NotificationChannel ongoing = new NotificationChannel(ONGOING, context.getString(R.string.channel_ongoing), NotificationManager.IMPORTANCE_LOW);
        ongoing.setDescription(context.getString(R.string.channel_ongoing_description));
        ongoing.setShowBadge(false);
        manager.createNotificationChannels(java.util.Arrays.asList(messages, mentions, calls, missed, ongoing));
    }

    /** A push has arrived (on PushService's thread: may block). What became of it goes in PushLog. */
    static void handlePush(Context context, JSONObject payload) {
        String type = payload.optString("type");
        try {
            createChannels(context);
            String callId = payload.optString("callId", null);
            if ("call_stop".equals(type)) {
                if (callId != null) stopRinging(context, callId);
                PushLog.add(context, type, "stopped ringing");
                return;
            }
            boolean ringing = "call".equals(type) && payload.optBoolean("ringing") && callId != null;
            if ("call".equals(type) && !ringing && callId != null) stopRinging(context, callId);
            JSONObject rendered = render(context, payload, ringing ? RENDER_CALL_MS : RENDER_MS);
            String outcome = ringing ? showRinging(context, payload, rendered, callId) : showMessage(context, payload, rendered);
            PushLog.add(context, ringing ? "call (ringing)" : type, rendered == null ? outcome + "; the page couldn't word it" : outcome);
        } catch (Exception e) {
            Log.e(TAG, "Couldn't show a push", e);
            PushLog.add(context, type, "error: " + e);
        }
    }

    private static JSONObject render(Context context, JSONObject payload, long timeoutMs) {
        try {
            JSONObject request = new JSONObject().put("type", "render").put("payload", payload);
            return NotifyRenderer.get(context).run(request, timeoutMs);
        } catch (Exception e) {
            return null;
        }
    }

    private static String text(JSONObject rendered, JSONObject payload, String key, String fallback) {
        if (rendered != null && !rendered.optString(key).isEmpty()) return rendered.optString(key);
        String own = payload.optString(key);
        return own.isEmpty() ? fallback : own;
    }

    private static String label(JSONObject rendered, String key, String fallback) {
        JSONObject labels = rendered == null ? null : rendered.optJSONObject("labels");
        String label = labels == null ? "" : labels.optString(key);
        return label.isEmpty() ? fallback : label;
    }

    private static String tagOf(JSONObject payload) {
        String tag = payload.optString("tag");
        return tag.isEmpty() ? payload.optString("type", "voicaw") : tag;
    }

    /** Opens the app at `url` (a path such as /dm/5). */
    static Intent openApp(Context context, String url) {
        return new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .putExtra(EXTRA_URL, url)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    static int flags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    }

    private static String showMessage(Context context, JSONObject payload, JSONObject rendered) {
        String type = payload.optString("type");
        String tag = tagOf(payload);
        String title = text(rendered, payload, "title", "Voicaw");
        String body = text(rendered, payload, "body", "");
        String url = text(rendered, payload, "url", "/");
        String channel = "call".equals(type) ? MISSED_CALLS : "guild".equals(type) ? MENTIONS : MESSAGES;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(context.getColor(R.color.notification))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setCategory("call".equals(type) ? NotificationCompat.CATEGORY_MISSED_CALL : NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(PendingIntent.getActivity(context, tag.hashCode(), openApp(context, url), flags()));
        long timestamp = payload.optLong("timestamp", 0);
        if (timestamp > 0) builder.setWhen(timestamp * 1000).setShowWhen(true);
        // As on the web: while the app is open, its own sound plays instead. Not for the test
        // (Settings → Notifications), which is there to show what a notification looks like.
        boolean silent = MainActivity.isInForeground() && !"test".equals(type);
        if (silent) builder.setSilent(true);
        Bitmap picture = loadPicture(context, rendered != null ? rendered.optString("icon", null) : null);
        if (picture != null) builder.setLargeIcon(picture);
        String posted = post(context, tag, channel, builder.build());
        return posted == null ? (silent ? "shown silently (the app was open)" : "shown") : posted;
    }

    private static String showRinging(Context context, JSONObject payload, JSONObject rendered, String callId) {
        String tag = "call-" + callId;
        boolean group = payload.has("groupId");
        String title = text(rendered, payload, "title", label(rendered, group ? "groupCall" : "incomingCall", "Voicaw"));
        String body = text(rendered, payload, "body", label(rendered, "incomingCall", ""));
        String url = text(rendered, payload, "url", "/");
        Bitmap picture = loadPicture(context, rendered != null ? rendered.optString("icon", null) : null);
        if (picture != null) callerPictures.put(callId, picture);

        Intent screen = new Intent(context, IncomingCallActivity.class)
            .putExtra(EXTRA_CALL_ID, callId)
            .putExtra(EXTRA_URL, url)
            .putExtra(IncomingCallActivity.EXTRA_TITLE, title)
            .putExtra(IncomingCallActivity.EXTRA_BODY, body)
            .putExtra(IncomingCallActivity.EXTRA_ANSWER_LABEL, label(rendered, "answer", context.getString(R.string.answer)))
            .putExtra(IncomingCallActivity.EXTRA_DECLINE_LABEL, label(rendered, "decline", context.getString(R.string.decline)))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent fullScreen = PendingIntent.getActivity(context, tag.hashCode(), screen, flags());
        PendingIntent answer = PendingIntent.getActivity(context, tag.hashCode() + 1, answerIntent(context, callId, url), flags());
        PendingIntent decline = PendingIntent.getBroadcast(
            context, tag.hashCode() + 2,
            new Intent(context, CallActionReceiver.class).setAction(CallActionReceiver.DECLINE).putExtra(EXTRA_CALL_ID, callId),
            flags()
        );
        Person.Builder caller = new Person.Builder().setName(title).setImportant(true);
        if (picture != null) caller.setIcon(IconCompat.createWithBitmap(picture));

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(context.getColor(R.color.notification))
            .setContentTitle(title)
            .setContentText(body)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setTimeoutAfter(RING_MS)
            .setContentIntent(fullScreen)
            .setFullScreenIntent(fullScreen, true)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller.build(), decline, answer));
        if (picture != null) builder.setLargeIcon(picture);
        Notification notification = builder.build();
        // Rings until answered, declined or stopped, not just once.
        notification.flags |= Notification.FLAG_INSISTENT;
        String posted = post(context, tag, CALLS, notification);
        if (posted != null) return posted;
        boolean fullScreenAllowed = Build.VERSION.SDK_INT < 34
            || context.getSystemService(NotificationManager.class).canUseFullScreenIntent();
        return fullScreenAllowed ? "ringing" : "ringing (as a notification: full screen not allowed)";
    }

    /** Opens the app and answers `callId` (useAndroidApp's `callAction`). */
    static Intent answerIntent(Context context, String callId, String url) {
        return openApp(context, url).putExtra(EXTRA_ANSWER, callId);
    }

    /** The call stopped ringing on this phone: its notification and ringing screen go. */
    static void stopRinging(Context context, String callId) {
        NotificationManagerCompat.from(context).cancel("call-" + callId, 0);
        callerPictures.remove(callId);
        IncomingCallActivity.finishFor(callId);
    }

    /** Shows it; null if it went up, else why it couldn't (for PushLog). */
    private static String post(Context context, String tag, String channel, Notification notification) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (!manager.areNotificationsEnabled()) return "not shown: notifications are off for the app";
        NotificationChannel settings = context.getSystemService(NotificationManager.class).getNotificationChannel(channel);
        if (settings != null && settings.getImportance() == NotificationManager.IMPORTANCE_NONE) {
            return "not shown: \"" + settings.getName() + "\" notifications are off";
        }
        try {
            manager.notify(tag, 0, notification);
            return null;
        } catch (SecurityException e) {
            Log.w(TAG, "Notifications aren't allowed", e);
            return "not shown: not allowed (" + e.getMessage() + ")";
        }
    }

    /** A picture for the notification (a profile picture), or null. */
    private static Bitmap loadPicture(Context context, String url) {
        if (url == null || url.isEmpty()) return null;
        try {
            Uri uri = Uri.parse(url);
            InputStream in;
            if ("localhost".equals(uri.getHost())) {
                in = context.getAssets().open("public" + uri.getPath());
            } else if ("https".equals(uri.getScheme())) {
                HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setConnectTimeout(3000);
                connection.setReadTimeout(3000);
                if (connection.getResponseCode() != 200 || connection.getContentLength() > 2_000_000) return null;
                in = connection.getInputStream();
            } else {
                return null;
            }
            try (InputStream stream = in) {
                Bitmap bitmap = BitmapFactory.decodeStream(stream);
                if (bitmap == null) return null;
                int size = Math.min(256, Math.min(bitmap.getWidth(), bitmap.getHeight()));
                return Bitmap.createScaledBitmap(bitmap, size, size, true);
            }
        } catch (Exception e) {
            Log.w(TAG, "No picture for the notification", e);
            return null;
        }
    }
}
