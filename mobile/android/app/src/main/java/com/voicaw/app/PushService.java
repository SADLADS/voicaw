package com.voicaw.app;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONObject;

import java.util.Map;

/**
 * Firebase delivers the server's pushes here, also while the app is closed (it starts the app's
 * process for them). Each is encrypted for this phone (PushCrypto); Notifications shows it.
 */
public class PushService extends FirebaseMessagingService {
    private static final String TAG = "VoicawPush";
    private static final String PREFS = "voicaw-push";
    private static final String LOGGED_OUT = "loggedOut";

    /**
     * Set by the page on every logout (services/logout.js), cleared once it registers this
     * phone's token for a login again (pushService.js ensureSubscription). A logout that couldn't
     * reach the server leaves the token registered to that account, so until then its pushes
     * are dropped here, unseen (security audit, 2026-11-19).
     */
    static void setLoggedOut(Context context, boolean loggedOut) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(LOGGED_OUT, loggedOut).commit();
    }

    static boolean isLoggedOut(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(LOGGED_OUT, false);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        if (!"1".equals(data.get("v")) || data.get("p") == null) {
            PushLog.add(this, null, "ignored: not a Voicaw push");
            return;
        }
        if (isLoggedOut(this)) {
            PushLog.add(this, null, "ignored: nobody is logged in");
            return;
        }
        JSONObject payload;
        try {
            payload = new JSONObject(PushCrypto.open(PushCrypto.deviceKey(this), data.get("p")));
        } catch (Exception e) {
            // Not for this key (e.g. sent before the app was reinstalled).
            Log.w(TAG, "Couldn't open a push", e);
            PushLog.add(this, null, "couldn't open it (sealed with another key)");
            return;
        }
        Notifications.handlePush(this, payload);
    }

    @Override
    public void onNewToken(@NonNull String token) {
        // The page registers the new token the next time the app opens (useAndroidApp); until
        // then the server still has the old one, and drops it once Firebase says it's gone.
        Log.i(TAG, "New push token");
    }
}
