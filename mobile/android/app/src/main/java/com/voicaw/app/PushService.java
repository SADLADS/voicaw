package com.voicaw.app;

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

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        if (!"1".equals(data.get("v")) || data.get("p") == null) {
            PushLog.add(this, null, "ignored: not a Voicaw push");
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
