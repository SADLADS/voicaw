package com.voicaw.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

/**
 * Buttons on the call notifications: Decline on a ringing call (works with the app closed: the
 * hidden page declines with the app's login), and Mute / Unmute / Hang up on the ongoing call
 * (passed to the page, useAndroidApp's `callAction`).
 */
public class CallActionReceiver extends BroadcastReceiver {
    static final String DECLINE = "com.voicaw.app.DECLINE";
    static final String MUTE = "com.voicaw.app.MUTE";
    static final String UNMUTE = "com.voicaw.app.UNMUTE";
    static final String HANG_UP = "com.voicaw.app.HANG_UP";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (DECLINE.equals(action)) {
            String callId = intent.getStringExtra(Notifications.EXTRA_CALL_ID);
            if (callId == null) return;
            decline(context, callId, goAsync());
        } else if (MUTE.equals(action)) {
            VoicawPlugin.emitCallAction("mute", null);
        } else if (UNMUTE.equals(action)) {
            VoicawPlugin.emitCallAction("unmute", null);
        } else if (HANG_UP.equals(action)) {
            // With the page gone there's no call left to hang up: just the notification.
            if (!VoicawPlugin.emitCallAction("hangUp", null)) CallService.stop(context);
        }
    }

    /**
     * Stops ringing at once, then tells the server (in the background, up to 9 s: a receiver's
     * `pending` result must finish within 10).
     */
    static void decline(Context context, String callId, PendingResult pending) {
        Notifications.stopRinging(context, callId);
        Context app = context.getApplicationContext();
        new Thread(() -> {
            try {
                NotifyRenderer.get(app).run(new JSONObject().put("type", "decline").put("callId", callId), 9_000);
            } catch (Exception ignored) {
                // The call rings out on the caller's side instead.
            } finally {
                if (pending != null) pending.finish();
            }
        }).start();
    }

    static Intent intent(Context context, String action) {
        return new Intent(context, CallActionReceiver.class).setAction(action);
    }
}
